import { requestUrl } from "obsidian";

export class AuthError extends Error {
	name = "AuthError";
}

/** GitHub couldn't be reached at all (offline, no signal, DNS, timeout). Sync resumes when back online. */
export class NetworkError extends Error {
	name = "NetworkError";
}

export function isOffline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * A GitHub login. GitHub App logins come with an access token that lasts
 * 8 hours and a refresh token (6 months) that trades for a new pair.
 * OAuth App logins have only the access token, which doesn't expire.
 */
export interface Credentials {
	access: string;
	refresh?: string;
	/** ms since epoch */
	expiresAt?: number;
	refreshExpiresAt?: number;
}

// Refresh a little early so a sync never starts with a token about to lapse.
const EARLY_MS = 5 * 60 * 1000;

export async function postForm(url: string, params: Record<string, string>): Promise<any> {
	if (isOffline()) throw new NetworkError("Offline");
	let res;
	try {
		res = await requestUrl({
			url,
			method: "POST",
			headers: { Accept: "application/json" },
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams(params).toString(),
			throw: false,
		});
	} catch (e) {
		throw new NetworkError(`Couldn't reach GitHub's login service: ${e instanceof Error ? e.message : e}`);
	}
	if (res.status < 400) return res.json;
	let detail = "";
	try {
		detail = res.json?.error_description ?? res.json?.error ?? "";
	} catch {
		/* not json */
	}
	const what = `GitHub login service: ${res.status}${detail ? ` ${detail}` : ""} (POST ${new URL(url).pathname})`;
	// Busy or broken on GitHub's side: try again later, keep the login.
	if (res.status === 429 || res.status >= 500) throw new Error(what);
	throw new AuthError(what);
}

export function credentialsFrom(j: any): Credentials {
	const now = Date.now();
	return {
		access: j.access_token,
		refresh: j.refresh_token || undefined,
		expiresAt: j.expires_in ? now + j.expires_in * 1000 : undefined,
		refreshExpiresAt: j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : undefined,
	};
}

/** Hands out a working access token, refreshing it when needed. */
export class Auth {
	private refreshing: Promise<string> | null = null;

	constructor(
		private load: () => Credentials | null,
		private store: (c: Credentials | null) => void,
		private clientId: () => string,
		private onRenew: (c: Credentials) => void = () => {},
	) {}

	async accessToken(): Promise<string> {
		const c = this.load();
		if (!c) throw new AuthError("Not logged in to GitHub");
		if (c.expiresAt && Date.now() > c.expiresAt - EARLY_MS) return this.refresh(c);
		return c.access;
	}

	/** GitHub rejected `rejected`; get a new token or throw AuthError. */
	async renew(rejected: string): Promise<string> {
		const c = this.load();
		if (!c) throw new AuthError("Not logged in to GitHub");
		// Another request already refreshed while this one was in flight.
		if (c.access !== rejected) return c.access;
		return this.refresh(c);
	}

	/** Refresh tokens are single-use, so concurrent callers share one refresh. */
	private refresh(c: Credentials): Promise<string> {
		this.refreshing ??= this.doRefresh(c).finally(() => (this.refreshing = null));
		return this.refreshing;
	}

	private async doRefresh(c: Credentials): Promise<string> {
		if (!c.refresh) throw new AuthError("GitHub rejected the login, and this kind of login can't be renewed");
		if (c.refreshExpiresAt && Date.now() > c.refreshExpiresAt) {
			throw new AuthError(`GitHub login expired: it could be renewed until ${new Date(c.refreshExpiresAt).toLocaleDateString()}`);
		}
		// A network failure here throws NetworkError: keep the login and retry later.
		const j = await postForm("https://github.com/login/oauth/access_token", {
			client_id: this.clientId(),
			grant_type: "refresh_token",
			refresh_token: c.refresh,
		});
		if (!j.access_token) {
			throw new AuthError(`GitHub refused to renew the login: ${j.error_description ?? j.error ?? "no reason given"}${j.error ? ` (${j.error})` : ""}`);
		}
		const next = credentialsFrom(j);
		this.store(next);
		this.onRenew(next);
		return next.access;
	}
}
