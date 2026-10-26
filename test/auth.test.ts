import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth, AuthError, Credentials, NetworkError } from "../src/auth";
import { GitHub } from "../src/github";

const HOUR = 3600_000;

/** Fake GitHub: login server issuing rotating refresh tokens, and an API accepting only the current token. */
function fakeGitHub(opts: { refreshResponse?: () => any; offline?: boolean; api?: (req: any) => any } = {}) {
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
		const custom = opts.api?.(req);
		if (custom) return custom;
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

test("a 401 on one request while the login still works is an error, not a logout", async () => {
	const { auth, get } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() + 8 * HOUR });
	const { calls } = fakeGitHub({ api: (req) => (req.url.endsWith("/git/blobs") ? { status: 401, json: { message: "odd" }, headers: {} } : null) });
	await assert.rejects(new GitHub(auth, "o/r").createBlob(new Uint8Array([1])), (e) => !(e instanceof AuthError) && /401.*the login itself still works/.test(String(e)));
	assert.equal(get()!.refresh, "refresh-0");
	assert.equal(calls.refresh, 0, "a working login is not renewed");
});

test("when GitHub says slow down, it waits and retries", async () => {
	let n = 0;
	const waits: string[] = [];
	fakeGitHub({
		api: () => (n++ === 0 ? { status: 403, json: { message: "You have exceeded a secondary rate limit" }, headers: { "Retry-After": "1" } } : null),
	});
	const { auth } = makeAuth({ access: "access-0" });
	assert.equal(await new GitHub(auth, "o/r", (s) => waits.push(s)).user(), "me");
	assert.deepEqual(waits, ["GitHub 403 Forbidden on GET /user: You have exceeded a secondary rate limit; waiting 1 s as GitHub asks (1 of 5)"]);
});

test("429s and 5xx are retried with detail; persistent 5xx fails with GitHub's message and request id", async () => {
	const notes: string[] = [];
	const seq = [
		{ status: 429, json: { message: "Too many" }, headers: { "retry-after": "1" } },
		{ status: 502, text: "<html><body>Bad gateway</body></html>", get json() { throw new Error("not json"); }, headers: {} },
		null,
	];
	fakeGitHub({ api: () => seq.shift() ?? null });
	const { auth } = makeAuth({ access: "access-0" });
	assert.equal(await new GitHub(auth, "o/r", (m) => notes.push(m)).user(), "me");
	assert.match(notes[0], /^GitHub 429 Too Many Requests on GET \/user: Too many; waiting 1 s/);
	assert.match(notes[1], /^GitHub 502 Bad Gateway on GET \/user: Bad gateway; retrying in 2 s \(1 of 3\)/);

	fakeGitHub({ api: () => ({ status: 422, json: { message: "Invalid tree info", errors: [{ resource: "Tree", field: "path", code: "invalid" }] }, headers: { "X-GitHub-Request-Id": "AB:CD" } }) });
	await assert.rejects(
		new GitHub(auth, "me/vault").createTree("t", [{ path: "a.md", mode: "100644", sha: "x" }]),
		/^Error: GitHub 422 Unprocessable on POST \/git\/trees: Invalid tree info \(Tree path invalid\) \[request AB:CD\]$/,
	);
});

test("offline: no requests, no retries, and a NetworkError (not a logout)", async () => {
	const { calls } = fakeGitHub();
	const { auth, get } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() - 1 });
	Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
	try {
		await assert.rejects(new GitHub(auth, "o/r").user(), NetworkError);
		assert.equal(calls.api + calls.refresh, 0);
		assert.equal(get()!.refresh, "refresh-0");
	} finally {
		Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
	}
});

test("a dropped connection is retried, then reported as a NetworkError", async () => {
	const notes: string[] = [];
	let n = 0;
	fakeGitHub({ api: () => { if (n++ < 1) throw new Error("net::ERR_CONNECTION_RESET"); return null; } });
	const { auth } = makeAuth({ access: "access-0" });
	assert.equal(await new GitHub(auth, "o/r", (m) => notes.push(m)).user(), "me");
	assert.match(notes[0], /Couldn't reach GitHub for GET \/user: net::ERR_CONNECTION_RESET; retrying in 2 s/);
});

test("if another copy of the plugin renewed first, its new login is used instead of logging out", async () => {
	fakeGitHub({ refreshResponse: () => ({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }) });
	let stored: Credentials | null = { access: "access-0", refresh: "refresh-0", expiresAt: Date.now() - 1 };
	const auth = new Auth(
		() => stored,
		(c) => (stored = c),
		() => "Iv1.test",
	);
	// Simulate the other copy winning the race: storage changes while our refresh is in flight.
	const realLoad = (auth as any).load;
	let n = 0;
	(auth as any).load = () => (n++ === 0 ? realLoad() : { access: "access-other", refresh: "refresh-other" });
	assert.equal(await auth.accessToken(), "access-other");
});

test("a refused renewal says why", async () => {
	fakeGitHub({ refreshResponse: () => ({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }) });
	const { auth } = makeAuth({ access: "access-0", refresh: "refresh-0", expiresAt: Date.now() - 1 });
	await assert.rejects(auth.accessToken(), /GitHub refused to renew the login: The refresh token passed is incorrect or expired\. \(bad_refresh_token\)/);
});
