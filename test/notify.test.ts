import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncFailure } from "../src/engine";
import { unannounced } from "../src/notify";

const fail = (path: string, request: string, direction: "up" | "down" = "up"): SyncFailure => ({
	path,
	direction,
	error: `Couldn't sync attachment "${path}": GitHub 502 Bad Gateway on POST /git/blobs [request ${request}]`,
});

test("each failing file is announced once, even though GitHub's message changes every sync", () => {
	let notified = new Set<string>();
	let r = unannounced(notified, [fail("a.png", "1")]);
	assert.deepEqual(r.fresh.map((f) => f.path), ["a.png"]);
	notified = r.notified;

	r = unannounced(notified, [fail("a.png", "2")]);
	assert.deepEqual(r.fresh, [], "same file, new request id: no repeat");
	notified = r.notified;

	r = unannounced(notified, [fail("a.png", "3"), fail("b.png", "3")]);
	assert.deepEqual(r.fresh.map((f) => f.path), ["b.png"], "only the new file");
	notified = r.notified;

	r = unannounced(notified, [fail("b.png", "4")]);
	assert.deepEqual(r.fresh, []);
	notified = r.notified;

	r = unannounced(notified, [fail("a.png", "5"), fail("b.png", "5")]);
	assert.deepEqual(r.fresh.map((f) => f.path), ["a.png"], "a.png synced in between, so its new failure is announced");
});

test("the same path failing in the other direction is a different problem", () => {
	const r1 = unannounced(new Set(), [fail("x.md", "1", "down")]);
	const r2 = unannounced(r1.notified, [fail("x.md", "2", "down"), fail("x.md", "2", "up")]);
	assert.deepEqual(r2.fresh.map((f) => f.direction), ["up"]);
});
