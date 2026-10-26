import { arrayBufferToBase64, requestUrl, RequestUrlResponse } from "obsidian";
import { Auth, AuthError, Credentials, credentialsFrom, isOffline, NetworkError, postForm } from "./auth";
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
		/** Told about retries (rate limits, GitHub hiccups), as a line for the activity log. */
		private onNotice: (msg: string) => void = () => {},
	) {}

	private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<RequestUrlResponse> {
		const token = await this.auth.accessToken();
		const res = await this.sendWithRetries(token, method, path, body, accept);
		if (res.status !== 401) return res;
		// GitHub sometimes answers one request with 401 while the login is fine. Renewing then
		// would only churn the single-use renewal token, so first check the login itself.
		const check = await this.sendWithRetries(token, "GET", "/user", undefined, "application/vnd.github+json");
		if (check.status !== 401) throw new Error(`${describe(res, method, path)} (the login itself still works)`);
		this.onNotice(`${describe(check, "GET", "/user")}; renewing the login`);
		const fresh = await this.auth.renew(token);
		const retry = await this.sendWithRetries(fresh, method, path, body, accept);
		if (retry.status !== 401) return retry;
		throw new AuthError(`GitHub rejected the login even after renewing it (${describe(retry, method, path)})`);
	}

	/**
	 * send(), retrying what is worth retrying:
	 *  - 429, or 403 for a rate limit: wait as long as GitHub says
	 *  - 5xx and network failures: GitHub hiccups, retried after 2, 5, then 15 s
	 * Every request we make is safe to repeat (GitHub stores content by its id,
	 * and moving a branch to the same commit twice is harmless).
	 */
	private async sendWithRetries(token: string, method: string, path: string, body: unknown, accept: string): Promise<RequestUrlResponse> {
		const backoff = [2, 5, 15];
		let waits = 0;
		let hiccups = 0;
		for (;;) {
			if (isOffline()) throw new NetworkError("Offline");
			let res: RequestUrlResponse;
			try {
				res = await this.send(token, method, path, body, accept);
			} catch (e) {
				const why = `Couldn't reach GitHub for ${method} ${shortPath(path)}: ${e instanceof Error ? e.message : e}`;
				// No point retrying while the device says it has no connection.
				if (isOffline() || hiccups >= backoff.length) throw new NetworkError(why);
				this.onNotice(`${why}; retrying in ${backoff[hiccups]} s (${hiccups + 1} of ${backoff.length})`);
				await sleep(backoff[hiccups++]);
				continue;
			}
			const wait = slowDownSeconds(res);
			if (wait !== null) {
				if (wait > 5 * 60 || waits >= 5) {
					throw new Error(`${describe(res, method, path)}. GitHub's limit resets in about ${Math.ceil(wait / 60)} min; sync will resume then.`);
				}
				this.onNotice(`${describe(res, method, path)}; waiting ${wait} s as GitHub asks (${++waits} of 5)`);
				await sleep(wait);
				continue;
			}
			if (res.status >= 500 && hiccups < backoff.length) {
				this.onNotice(`${describe(res, method, path)}; retrying in ${backoff[hiccups]} s (${hiccups + 1} of ${backoff.length})`);
				await sleep(backoff[hiccups++]);
				continue;
			}
			return res;
		}
	}

	private send(token: string, method: string, path: string, body: unknown, accept: string): Promise<RequestUrlResponse> {
		const json = body === undefined ? undefined : JSON.stringify(body);
		const request = requestUrl({
			url: `${API}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: accept,
				"X-GitHub-Api-Version": "2022-11-28",
				"Cache-Control": "no-cache",
			},
			contentType: body === undefined ? undefined : "application/json",
			body: json,
			throw: false,
		});
		// requestUrl has no timeout of its own; a stuck request would hang the sync forever.
		// Allow extra time for big uploads, assuming a slow (400 kbit/s) upload link.
		const limit = Math.round(REQUEST_TIMEOUT_S + (json?.length ?? 0) / 50_000);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no answer within ${limit} s`)), limit * 1000);
		});
		return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
	}

	private async json(method: string, path: string, body?: unknown): Promise<any> {
		const res = await this.call(method, path, body);
		if (res.status >= 400) throw apiError(res, method, path);
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
		const path = this.r(`/git/ref/heads/${branch}`);
		const res = await this.call("GET", path);
		if (res.status === 404) throw new Error(`Branch "${branch}" not found in ${this.repo} (${describe(res, "GET", path)})`);
		if (res.status === 409) throw new Error(`${this.repo} is empty. Add any file (a README is fine) on GitHub first.`);
		if (res.status >= 400) throw apiError(res, "GET", path);
		return res.json.object.sha;
	}

	async getTree(commit: string): Promise<RemoteTree> {
		const c = await this.json("GET", this.r(`/git/commits/${commit}`));
		return { treeSha: c.tree.sha, entries: await this.listTree(c.tree.sha) };
	}

	async listTree(treeSha: string): Promise<Map<string, RemoteEntry>> {
		const t = await this.json("GET", this.r(`/git/trees/${treeSha}?recursive=1`));
		if (t.truncated) throw new Error("This repository has too many files for GitHub to list in one go");
		const entries = new Map<string, RemoteEntry>();
		for (const e of t.tree) {
			// Plain files only: submodules (160000) and symlinks (120000) are skipped.
			if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755")) {
				entries.set(e.path, { sha: e.sha, mode: e.mode });
			}
		}
		return entries;
	}

	async getBlob(sha: string): Promise<Uint8Array> {
		const path = this.r(`/git/blobs/${sha}`);
		const res = await this.call("GET", path, undefined, "application/vnd.github.raw+json");
		if (res.status >= 400) throw apiError(res, "GET", path);
		return new Uint8Array(res.arrayBuffer);
	}

	async createBlob(data: Uint8Array): Promise<string> {
		const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		return (await this.json("POST", this.r("/git/blobs"), { content: arrayBufferToBase64(buf), encoding: "base64" })).sha;
	}

	async createTree(baseTree: string, changes: TreeChange[]): Promise<string> {
		const tree = changes.map((c) =>
			c.content !== undefined && c.sha !== null
				? { path: c.path, mode: c.mode, type: "blob", content: c.content }
				: { path: c.path, mode: c.mode, type: "blob", sha: c.sha },
		);
		return (await this.json("POST", this.r("/git/trees"), { base_tree: baseTree, tree })).sha;
	}

	async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
		return (await this.json("POST", this.r("/git/commits"), { message, tree, parents })).sha;
	}

	async updateRef(branch: string, sha: string, force: boolean): Promise<boolean> {
		const path = this.r(`/git/refs/heads/${branch}`);
		const res = await this.call("PATCH", path, { sha, force });
		if (res.status < 400) return true;
		if (res.status === 422 && /does not exist/i.test(messageOf(res))) {
			const created = await this.call("POST", this.r("/git/refs"), { ref: `refs/heads/${branch}`, sha });
			if (created.status < 400) return true;
			// Created by a retried request a moment ago: just move it.
			if (created.status === 422 && /already exists/i.test(messageOf(created))) return this.updateRef(branch, sha, force);
			throw apiError(created, "POST", this.r("/git/refs"));
		}
		if (res.status === 422 && !force) return false;
		throw apiError(res, "PATCH", path);
	}

}

const REQUEST_TIMEOUT_S = 120;

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
	413: "Too Large", 422: "Unprocessable", 429: "Too Many Requests", 500: "Internal Server Error",
	502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

function header(res: RequestUrlResponse, name: string): string | undefined {
	for (const [k, v] of Object.entries(res.headers ?? {})) if (k.toLowerCase() === name) return v;
	return undefined;
}

function messageOf(res: RequestUrlResponse): string {
	try {
		return res.json?.message ?? "";
	} catch {
		return "";
	}
}

/** "/repos/me/vault/git/trees?recursive=1" -> "/git/trees" */
function shortPath(path: string): string {
	return path.split("?")[0].replace(/^\/repos\/[^/]+\/[^/]+/, "") || "/";
}

/**
 * Everything useful GitHub said about a failed request, on one line:
 * status, which request, GitHub's message and field errors (or the start of
 * a non-JSON body), and GitHub's request id for support.
 */
export function describe(res: RequestUrlResponse, method: string, path: string): string {
	let detail = "";
	try {
		const j = res.json;
		detail = j?.message ?? "";
		if (Array.isArray(j?.errors) && j.errors.length) {
			const errs = j.errors.map((e: any) => (typeof e === "string" ? e : e.message ?? [e.resource, e.field, e.code].filter(Boolean).join(" "))).join("; ");
			detail += ` (${errs})`;
		}
	} catch {
		try {
			detail = res.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
		} catch {
			/* no body */
		}
	}
	const id = header(res, "x-github-request-id");
	const status = `${res.status}${STATUS_TEXT[res.status] ? ` ${STATUS_TEXT[res.status]}` : ""}`;
	return `GitHub ${status} on ${method} ${shortPath(path)}${detail ? `: ${detail}` : ""}${id ? ` [request ${id}]` : ""}`;
}

/** Seconds GitHub wants us to wait before retrying, or null if this isn't a "slow down" response. */
function slowDownSeconds(res: RequestUrlResponse): number | null {
	if (res.status !== 403 && res.status !== 429) return null;
	const retryAfter = Number(header(res, "retry-after"));
	if (retryAfter > 0) return retryAfter;
	if (header(res, "x-ratelimit-remaining") === "0") {
		const reset = Number(header(res, "x-ratelimit-reset"));
		return reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60;
	}
	if (res.status === 429 || /rate limit/i.test(messageOf(res))) return 60;
	return null;
}

function apiError(res: RequestUrlResponse, method: string, path: string): Error {
	const what = describe(res, method, path);
	if (res.status === 404) return new Error(`${what}. Does your sync app have access to this repository?`);
	if (res.status === 403 && /not accessible by integration/i.test(messageOf(res))) {
		return new Error(`${what}. Your sync app needs "Contents: Read and write" permission and access to this repository.`);
	}
	return new Error(what);
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
