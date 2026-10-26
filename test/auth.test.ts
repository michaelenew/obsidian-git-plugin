import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth, AuthError, Credentials } from "../src/auth";
import { GitHub } from "../src/github";

const HOUR = 3600_000;

/** Fake GitHub: login server issuing rotating refresh tokens, and an API accepting only the current token. */
function fakeGitHub(opts: { refreshResponse?: () => any; offline?: boolean } = {}) {
	let n = 0;
	let valid = "access-0";
	const calls = { refresh: 0, api: 0 };
	(globalThis as any).__requestUrl = async (req: any) => {
		if (req.url === "https://github.com/login/oauth/access_token") {
			calls.refresh++;
			if (opts.offline) throw new Error("net::ERR_INTERNET_DISCONNECTED");
			const params = new URLSearchParams(req.body);
			assert.equal(params.get("grant_type"), "refresh_token");
			assert.equal(params.get("client_secret"), null);
			const json = opts.refreshResponse?.() ?? (params.get("refresh_token") === `refresh-${n}`
				? (n++, valid = `access-${n}`, { access_token: valid, refresh_token: `refresh-${n}`, expires_in: 28800, refresh_token_expires_in: 15897600 })
				: { error: "bad_refresh_token" });
			return { status: 200, json };
		}
		calls.api++;
		const ok = req.headers.Authorization === `Bearer ${valid}`;
		return { status: ok ? 200 : 401, json: ok ? { login: "me" } : { message: "Bad credentials" }, headers: {} };
	};
	return { calls, expire: () => (valid = "revoked") };
}

function makeAuth(initial: Credentials | null) {
	let stored = initial;
	const auth = new Auth(() => stored, (c) => (stored = c), () => "Iv1.test");
	return { auth, get: () => stored };
}

test("a token near expiry is refreshed before use, and the new pair is stored", async () => {
	const { calls } = fakeGitHub();
	const { auth, get } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() + 60_000 });
	assert.equal(await new GitHub(auth, "o/r").user(), "me");
	assert.equal(calls.refresh, 1);
	assert.equal(get()!.access, "access-1");
	assert.equal(get()!.refresh, "refresh-1");
	assert.ok(get()!.expiresAt! > Date.now() + 7 * HOUR);
});

test("a 401 triggers one refresh and the request is retried", async () => {
	const gh = fakeGitHub();
	const { auth } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() + 8 * HOUR });
	gh.expire(); // GitHub stops accepting access-0 before we expected (e.g. clock skew)
	assert.equal(await new GitHub(auth, "o/r").user(), "me");
	assert.equal(gh.calls.refresh, 1);
});

test("many requests at once share a single refresh (refresh tokens are single-use)", async () => {
	const { calls } = fakeGitHub();
	const { auth } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() - 1 });
	const gh = new GitHub(auth, "o/r");
	const results = await Promise.all(Array.from({ length: 6 }, () => gh.user()));
	assert.deepEqual(results, Array(6).fill("me"));
	assert.equal(calls.refresh, 1);
});

test("a refused refresh means log in again", async () => {
	fakeGitHub({ refreshResponse: () => ({ error: "bad_refresh_token" }) });
	const { auth } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() - 1 });
	await assert.rejects(new GitHub(auth, "o/r").user(), AuthError);
});

test("an expired refresh token or a non-refreshable token that gets a 401 means log in again", async () => {
	const gh = fakeGitHub();
	const { auth } = makeAuth({ access: "x", refresh: "refresh-0", expiresAt: Date.now() - 1, refreshExpiresAt: Date.now() - 1 });
	await assert.rejects(new GitHub(auth, "o/r").user(), AuthError);
	gh.expire();
	const plain = makeAuth({ access: "oauth-app-token" });
	await assert.rejects(new GitHub(plain.auth, "o/r").user(), AuthError);
	assert.equal(gh.calls.refresh, 0);
});

test("being offline during a refresh is not a logout", async () => {
	fakeGitHub({ offline: true });
	const { auth, get } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() - 1 });
	await assert.rejects(new GitHub(auth, "o/r").user(), (e) => !(e instanceof AuthError));
	assert.equal(get()!.refresh, "refresh-0");
});
