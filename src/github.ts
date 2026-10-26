import { arrayBufferToBase64, requestUrl, RequestUrlResponse } from "obsidian";
import type { RemoteEntry, RemoteStore, RemoteTree, TreeChange } from "./engine";

// All network traffic goes through Obsidian's requestUrl, which works the same
// on desktop and mobile. The token is only ever sent to these two hosts.
const API = "https://api.github.com";
const WEB = "https://github.com";

export class AuthError extends Error {}

export interface RepoInfo {
	fullName: string;
	defaultBranch: string;
	private: boolean;
}

export class GitHub implements RemoteStore {
	constructor(
		private token: string,
		private repo: string,
	) {}

	private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<RequestUrlResponse> {
		const res = await requestUrl({
			url: `${API}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: accept,
				"X-GitHub-Api-Version": "2022-11-28",
				"Cache-Control": "no-cache",
			},
			contentType: body === undefined ? undefined : "application/json",
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
		if (res.status === 401) throw new AuthError("GitHub login expired or was revoked");
		return res;
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

	async listRepos(): Promise<RepoInfo[]> {
		const out: RepoInfo[] = [];
		for (let page = 1; page <= 5; page++) {
			const j = await this.json("GET", `/user/repos?per_page=100&sort=updated&page=${page}`);
			out.push(...j.map((x: any) => ({ fullName: x.full_name, defaultBranch: x.default_branch, private: x.private })));
			if (j.length < 100) break;
		}
		return out;
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

async function form(url: string, params: Record<string, string>): Promise<any> {
	const res = await requestUrl({
		url,
		method: "POST",
		headers: { Accept: "application/json" },
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(params).toString(),
		throw: false,
	});
	if (res.status >= 400) throw new Error(`GitHub login failed (${res.status})`);
	return res.json;
}

export async function startDeviceLogin(clientId: string): Promise<DeviceCode> {
	const j = await form(`${WEB}/login/device/code`, { client_id: clientId, scope: "repo" });
	if (j.error) throw new Error(j.error_description ?? j.error);
	return {
		deviceCode: j.device_code,
		userCode: j.user_code,
		verificationUri: j.verification_uri,
		interval: j.interval ?? 5,
		expiresAt: Date.now() + (j.expires_in ?? 900) * 1000,
	};
}

/** Wait for the user to approve the code. Resolves to the token. */
export async function waitForDeviceLogin(clientId: string, code: DeviceCode, cancelled: () => boolean): Promise<string> {
	let interval = code.interval;
	while (Date.now() < code.expiresAt) {
		await new Promise((r) => setTimeout(r, interval * 1000));
		if (cancelled()) throw new Error("cancelled");
		const j = await form(`${WEB}/login/oauth/access_token`, {
			client_id: clientId,
			device_code: code.deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (j.access_token) return j.access_token;
		if (j.error === "slow_down") interval = (j.interval ?? interval + 5);
		else if (j.error !== "authorization_pending") throw new Error(j.error_description ?? j.error);
	}
	throw new Error("The login code expired; try again");
}
