import { requestUrl } from "obsidian";

export class AuthError extends Error {}

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
	const res = await requestUrl({
		url,
		method: "POST",
		headers: { Accept: "application/json" },
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(params).toString(),
		throw: false,
	});
	if (res.status >= 500) throw new Error(`GitHub login service error (${res.status})`);
	if (res.status >= 400) throw new AuthError(`GitHub login failed (${res.status})`);
	return res.json;
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
		if (!c.refresh || (c.refreshExpiresAt && Date.now() > c.refreshExpiresAt)) {
			throw new AuthError("GitHub login expired");
		}
		// A network failure here throws a plain Error: keep the login and retry later.
		const j = await postForm("https://github.com/login/oauth/access_token", {
			client_id: this.clientId(),
			grant_type: "refresh_token",
			refresh_token: c.refresh,
		});
		if (!j.access_token) throw new AuthError(`GitHub login expired (${j.error ?? "refresh refused"})`);
		const next = credentialsFrom(j);
		this.store(next);
		return next.access;
	}
}
