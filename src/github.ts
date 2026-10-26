import { arrayBufferToBase64, requestUrl, RequestUrlResponse } from "obsidian";
import { Auth, AuthError, Credentials, credentialsFrom, postForm } from "./auth";
import type { RemoteEntry, RemoteStore, RemoteTree, TreeChange } from "./engine";

// All network traffic goes through Obsidian's requestUrl, which works the same
// on desktop and mobile. The token is only ever sent to these two hosts.
const API = "https://api.github.com";
const WEB = "https://github.com";

export interface RepoInfo {
	fullName: string;
	defaultBranch: string;
	private: boolean;
}

export class GitHub implements RemoteStore {
	constructor(
		private auth: Auth,
		private repo: string,
	) {}

	private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<RequestUrlResponse> {
		const token = await this.auth.accessToken();
		const res = await this.send(token, method, path, body, accept);
		if (res.status !== 401) return res;
		// Expired or revoked: refresh once and retry; if that fails too, the user must log in again.
		const retry = await this.send(await this.auth.renew(token), method, path, body, accept);
		if (retry.status === 401) throw new AuthError("GitHub login expired or was revoked");
		return retry;
	}

	private send(token: string, method: string, path: string, body: unknown, accept: string): Promise<RequestUrlResponse> {
		return requestUrl({
			url: `${API}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: accept,
				"X-GitHub-Api-Version": "2022-11-28",
				"Cache-Control": "no-cache",
			},
			contentType: body === undefined ? undefined : "application/json",
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
	}

	private async json(method: string, path: string, body?: unknown): Promise<any> {
		const res = await this.call(method, path, body);
		if (res.status >= 400) throw apiError(res);
		return res.json;
	}

	private r(path: string) {
		return `/repos/${this.repo}${path}`;
	}

	async user(): Promise<string> {
		return (await this.json("GET", "/user")).login;
	}

	async repoInfo(): Promise<RepoInfo> {
		const j = await this.json("GET", this.r(""));
		return { fullName: j.full_name, defaultBranch: j.default_branch, private: j.private };
	}

	/**
	 * Repositories this login can sync, plus the GitHub App's short name
	 * (for linking to its install page). GitHub App logins only reach the
	 * repositories the app is installed on.
	 */
	async listRepos(): Promise<{ repos: RepoInfo[]; appSlug: string | null }> {
		const toInfo = (x: any): RepoInfo => ({ fullName: x.full_name, defaultBranch: x.default_branch, private: x.private });
		const res = await this.call("GET", "/user/installations?per_page=100");
		if (res.status >= 400) {
			// Not a GitHub App login (e.g. an OAuth App): list everything the user can see.
			const j = await this.json("GET", "/user/repos?per_page=100&sort=updated");
			return { repos: j.map(toInfo), appSlug: null };
		}
		const installations: any[] = res.json.installations ?? [];
		const repos: RepoInfo[] = [];
		for (const inst of installations) {
			for (let page = 1; page <= 5; page++) {
				const j = await this.json("GET", `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
				repos.push(...j.repositories.map(toInfo));
				if (j.repositories.length < 100) break;
			}
		}
		return { repos, appSlug: installations[0]?.app_slug ?? null };
	}

	async getHead(branch: string): Promise<string> {
		const res = await this.call("GET", this.r(`/git/ref/heads/${branch}`));
		if (res.status === 404) throw new Error(`Branch "${branch}" not found in ${this.repo}`);
		if (res.status === 409) throw new Error(`${this.repo} is empty. Add any file (a README is fine) on GitHub first.`);
		if (res.status >= 400) throw apiError(res);
		return res.json.object.sha;
	}

	async getTree(commit: string): Promise<RemoteTree> {
		const c = await this.json("GET", this.r(`/git/commits/${commit}`));
		const t = await this.json("GET", this.r(`/git/trees/${c.tree.sha}?recursive=1`));
		if (t.truncated) throw new Error("This repository has too many files for GitHub to list in one go");
		const entries = new Map<string, RemoteEntry>();
		for (const e of t.tree) {
			// Plain files only: submodules (160000) and symlinks (120000) are skipped.
			if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755")) {
				entries.set(e.path, { sha: e.sha, mode: e.mode });
			}
		}
		return { treeSha: c.tree.sha, entries };
	}

	async getBlob(sha: string): Promise<Uint8Array> {
		const res = await this.call("GET", this.r(`/git/blobs/${sha}`), undefined, "application/vnd.github.raw+json");
		if (res.status >= 400) throw apiError(res);
		return new Uint8Array(res.arrayBuffer);
	}

	async createBlob(data: Uint8Array): Promise<string> {
		const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		return (await this.json("POST", this.r("/git/blobs"), { content: arrayBufferToBase64(buf), encoding: "base64" })).sha;
	}

	async createTree(baseTree: string, changes: TreeChange[]): Promise<string> {
		const tree = changes.map((c) => ({ path: c.path, mode: c.mode, type: "blob", sha: c.sha }));
		return (await this.json("POST", this.r("/git/trees"), { base_tree: baseTree, tree })).sha;
	}

	async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
		return (await this.json("POST", this.r("/git/commits"), { message, tree, parents })).sha;
	}

	async updateRef(branch: string, sha: string, force: boolean): Promise<boolean> {
		const res = await this.call("PATCH", this.r(`/git/refs/heads/${branch}`), { sha, force });
		if (res.status < 400) return true;
		if (res.status === 422 && /does not exist/i.test(res.text)) {
			await this.json("POST", this.r("/git/refs"), { ref: `refs/heads/${branch}`, sha });
			return true;
		}
		if (res.status === 422 && !force) return false;
		throw apiError(res);
	}
}

function apiError(res: RequestUrlResponse): Error {
	let msg = "";
	try {
		msg = res.json?.message ?? "";
	} catch {
		/* not json */
	}
	if ((res.status === 403 || res.status === 429) && res.headers["x-ratelimit-remaining"] === "0") {
		return new Error("GitHub rate limit reached; sync will resume within the hour");
	}
	if (res.status === 404) return new Error(`GitHub: not found (does the login have access to this repository?)`);
	return new Error(`GitHub ${res.status}${msg ? `: ${msg}` : ""}`);
}

/*
 * GitHub "device flow" login: GitHub shows the user a short code, the user
 * types it at github.com/login/device, and we receive a token. Nothing to
 * create or paste by hand.
 */
export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	interval: number;
	expiresAt: number;
}

export async function startDeviceLogin(clientId: string): Promise<DeviceCode> {
	const j = await postForm(`${WEB}/login/device/code`, { client_id: clientId, scope: "repo" });
	if (j.error) throw new Error(j.error_description ?? j.error);
	return {
		deviceCode: j.device_code,
		userCode: j.user_code,
		verificationUri: j.verification_uri,
		interval: j.interval ?? 5,
		expiresAt: Date.now() + (j.expires_in ?? 900) * 1000,
	};
}

/** Wait for the user to approve the code. */
export async function waitForDeviceLogin(clientId: string, code: DeviceCode, cancelled: () => boolean): Promise<Credentials> {
	let interval = code.interval;
	while (Date.now() < code.expiresAt) {
		await new Promise((r) => setTimeout(r, interval * 1000));
		if (cancelled()) throw new Error("cancelled");
		const j = await postForm(`${WEB}/login/oauth/access_token`, {
			client_id: clientId,
			device_code: code.deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (j.access_token) return credentialsFrom(j);
		if (j.error === "slow_down") interval = (j.interval ?? interval + 5);
		else if (j.error !== "authorization_pending") throw new Error(j.error_description ?? j.error);
	}
	throw new Error("The login code expired; try again");
}
