import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, LocalEntry, LocalStore, RemoteStore, RemoteTree, SyncEngine, TreeChange } from "../src/engine";
import { gitBlobSha } from "../src/sha";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);

/** A fake GitHub: blobs, flat trees and commits held in memory. */
class FakeGitHub implements RemoteStore {
	blobs = new Map<string, Uint8Array>();
	trees = new Map<string, Map<string, { sha: string; mode: string }>>();
	commits = new Map<string, { tree: string; parents: string[]; message: string }>();
	refs = new Map<string, string>();
	private n = 0;
	blobUploads = 0;
	treeCalls = 0;
	/** Simulates GitHub storing inline text differently from what was sent. */
	mangle: ((s: string) => string) | null = null;
	/** Called right before main is moved, to simulate another writer racing us. */
	beforeMainUpdate: (() => Promise<void>) | null = null;

	async seed(files: Record<string, string>, message = "seed") {
		const entries = new Map<string, { sha: string; mode: string }>();
		for (const [p, c] of Object.entries(files)) entries.set(p, { sha: await this.storeBlob(enc(c)), mode: "100644" });
		const tree = `t${this.n++}`;
		this.trees.set(tree, entries);
		const parent = this.refs.get("main");
		const commit = `c${this.n++}`;
		this.commits.set(commit, { tree, parents: parent ? [parent] : [], message });
		this.refs.set("main", commit);
	}

	/** Another writer (an agent, another device) edits main directly. */
	async edit(changes: Record<string, string | null>) {
		const current = new Map(this.trees.get(this.commits.get(this.refs.get("main")!)!.tree)!);
		for (const [p, c] of Object.entries(changes)) {
			if (c === null) current.delete(p);
			else current.set(p, { sha: await this.storeBlob(enc(c)), mode: "100644" });
		}
		const tree = `t${this.n++}`;
		this.trees.set(tree, current);
		const commit = `c${this.n++}`;
		this.commits.set(commit, { tree, parents: [this.refs.get("main")!], message: "edit" });
		this.refs.set("main", commit);
	}

	files(branch = "main"): Record<string, string> {
		const tree = this.trees.get(this.commits.get(this.refs.get(branch)!)!.tree)!;
		const out: Record<string, string> = {};
		for (const [p, e] of tree) out[p] = dec(this.blobs.get(e.sha)!);
		return out;
	}

	async getHead(branch: string) {
		const h = this.refs.get(branch);
		if (!h) throw new Error("no branch");
		return h;
	}
	async getTree(commit: string): Promise<RemoteTree> {
		const treeSha = this.commits.get(commit)!.tree;
		return { treeSha, entries: new Map(this.trees.get(treeSha)!) };
	}
	async getBlob(sha: string) {
		return this.blobs.get(sha)!;
	}
	async createBlob(data: Uint8Array) {
		this.blobUploads++;
		return this.storeBlob(data);
	}
	async storeBlob(data: Uint8Array) {
		const sha = await gitBlobSha(data);
		this.blobs.set(sha, data);
		return sha;
	}
	async createTree(baseTree: string, changes: TreeChange[]) {
		this.treeCalls++;
		const entries = new Map(this.trees.get(baseTree)!);
		for (const c of changes) {
			if (c.sha === null) entries.delete(c.path);
			else if (c.content !== undefined) {
				const text = this.mangle ? this.mangle(c.content) : c.content;
				entries.set(c.path, { sha: await this.storeBlob(enc(text)), mode: c.mode });
			} else {
				if (!this.blobs.has(c.sha)) throw new Error(`tree refers to missing blob for ${c.path}`);
				entries.set(c.path, { sha: c.sha, mode: c.mode });
			}
		}
		const tree = `t${this.n++}`;
		this.trees.set(tree, entries);
		return tree;
	}
	async listTree(treeSha: string) {
		return new Map(this.trees.get(treeSha)!);
	}
	async createCommit(message: string, tree: string, parents: string[]) {
		const commit = `c${this.n++}`;
		this.commits.set(commit, { tree, parents, message });
		return commit;
	}
	async updateRef(branch: string, sha: string, force: boolean) {
		if (branch === "main" && this.beforeMainUpdate) {
			const f = this.beforeMainUpdate;
			this.beforeMainUpdate = null;
			await f();
		}
		const cur = this.refs.get(branch);
		if (!force && cur && !this.commits.get(sha)!.parents.includes(cur)) return false;
		this.refs.set(branch, sha);
		return true;
	}
}

class FakeDisk implements LocalStore {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	trashed: string[] = [];
	private clock = 1;
	excluded: (p: string) => boolean = (p) => p.startsWith(".obsidian/") || p.startsWith("code/");

	put(path: string, content: string) {
		this.files.set(path, { data: enc(content), mtime: this.clock++ });
	}
	get(path: string) {
		const f = this.files.get(path);
		return f ? dec(f.data) : undefined;
	}
	async list(): Promise<LocalEntry[]> {
		return [...this.files]
			.filter(([p]) => !this.excluded(p))
			.map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.length }));
	}
	async read(path: string) {
		return this.files.get(path)!.data;
	}
	async write(path: string, data: Uint8Array) {
		this.files.set(path, { data, mtime: this.clock++ });
	}
	async remove(path: string) {
		this.trashed.push(path);
		this.files.delete(path);
	}
	async exists(path: string) {
		return this.files.has(path);
	}
	isExcluded(path: string) {
		return this.excluded(path);
	}
}

function device(gh: FakeGitHub, name: string, disk = new FakeDisk()) {
	const state = emptyState("x");
	const engine = new SyncEngine(disk, gh, {
		branch: "main",
		deviceName: name,
		deviceBranch: `sync/${name}`,
		state,
		saveState: async () => {},
		forbidden: () => ["gho_SECRETTOKEN123"],
		now: () => new Date(2026, 9, 26, 14, 30),
	});
	return { disk, engine, state };
}

test("first sync downloads everything, ignoring excluded paths", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "a.md": "A", "dir/b.md": "B", "code/x.md": "nested repo file" });
	const { disk, engine } = device(gh, "phone");
	const r = await engine.sync("full");
	assert.deepEqual(r.pulled.sort(), ["a.md", "dir/b.md"]);
	assert.equal(disk.get("a.md"), "A");
	assert.equal(disk.get("code/x.md"), undefined);
	assert.equal(r.commit, null);
});

test("first sync with existing local files uploads them and keeps both on clash", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "same.md": "S", "clash.md": "remote" });
	const { disk, engine } = device(gh, "mac");
	disk.put("same.md", "S");
	disk.put("clash.md", "local");
	disk.put("new.md", "N");
	const r = await engine.sync("full");
	const files = gh.files();
	assert.equal(files["new.md"], "N");
	assert.equal(files["clash.md"], "local");
	assert.equal(files["clash (conflict 2026-10-26 1430).md"], "remote");
	assert.deepEqual(r.conflicts, ["clash (conflict 2026-10-26 1430).md"]);
	assert.equal(gh.refs.get("sync/mac"), gh.refs.get("main"));
});

test("edits travel phone -> GitHub -> laptop, with one commit listing the files", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "a.md": "A" });
	const phone = device(gh, "phone");
	const mac = device(gh, "mac");
	await phone.engine.sync("full");
	await mac.engine.sync("full");

	phone.disk.put("a.md", "A edited");
	phone.disk.put("img.png", "\x89PNG binary");
	const r = await phone.engine.sync("full");
	assert.deepEqual(r.pushed, [{ path: "a.md", kind: "modified" }, { path: "img.png", kind: "added" }]);
	const msg = gh.commits.get(r.commit!)!.message;
	assert.match(msg, /^phone: a\.md, img\.png\n\nmodified: a\.md\nadded: img\.png/);

	const p = await mac.engine.sync("pull");
	assert.deepEqual(p.pulled.sort(), ["a.md", "img.png"]);
	assert.equal(mac.disk.get("a.md"), "A edited");
});

test("pull with nothing new costs one request", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "a.md": "A" });
	const { engine } = device(gh, "phone");
	await engine.sync("full");
	let treeCalls = 0;
	const orig = gh.getTree.bind(gh);
	gh.getTree = async (c) => (treeCalls++, orig(c));
	await engine.sync("pull");
	await engine.sync("pull");
	assert.equal(treeCalls, 0);
});

test("edits to different lines of the same note merge cleanly", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "n.md": "one\ntwo\nthree\n" });
	const { disk, engine } = device(gh, "phone");
	await engine.sync("full");
	disk.put("n.md", "ONE\ntwo\nthree\n");
	await gh.edit({ "n.md": "one\ntwo\nTHREE\n" });
	const r = await engine.sync("full");
	assert.deepEqual(r.merged, ["n.md"]);
	assert.equal(disk.get("n.md"), "ONE\ntwo\nTHREE\n");
	assert.equal(gh.files()["n.md"], "ONE\ntwo\nTHREE\n");
});

test("edits to the same line keep both versions inside markers", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "n.md": "one\ntwo\n" });
	const { disk, engine } = device(gh, "phone");
	await engine.sync("full");
	disk.put("n.md", "one\nphone\n");
	await gh.edit({ "n.md": "one\nagent\n" });
	const r = await engine.sync("full");
	assert.deepEqual(r.conflicts, ["n.md"]);
	const text = gh.files()["n.md"];
	assert.ok(text.includes("phone") && text.includes("agent") && text.includes("<<<<<<< phone (this device)"));
	assert.equal(disk.get("n.md"), text);
});

test("pull mode leaves files changed on both sides alone", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "n.md": "base", "other.md": "o" });
	const { disk, engine } = device(gh, "mac");
	await engine.sync("full");
	disk.put("n.md", "typing...");
	await gh.edit({ "n.md": "remote", "other.md": "o2" });
	const r = await engine.sync("pull");
	assert.deepEqual(r.skipped, ["n.md"]);
	assert.deepEqual(r.pulled, ["other.md"]);
	assert.equal(disk.get("n.md"), "typing...");
	assert.equal(r.commit, null);
	// And a pull right after does not short-circuit past the unsettled file.
	const r2 = await engine.sync("pull");
	assert.deepEqual(r2.skipped, ["n.md"]);
});

test("deletes propagate both ways; delete-vs-edit keeps the edit", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "gone-here.md": "1", "gone-there.md": "2", "del-vs-edit.md": "3", "edit-vs-del.md": "4" });
	const { disk, engine } = device(gh, "phone");
	await engine.sync("full");
	disk.files.delete("gone-here.md");
	disk.files.delete("del-vs-edit.md");
	disk.put("edit-vs-del.md", "4 edited here");
	await gh.edit({ "gone-there.md": null, "del-vs-edit.md": "3 edited there", "edit-vs-del.md": null });
	await engine.sync("full");
	const files = gh.files();
	assert.equal(files["gone-here.md"], undefined);
	assert.equal(disk.get("gone-there.md"), undefined);
	assert.deepEqual(disk.trashed, ["gone-there.md"]);
	assert.equal(disk.get("del-vs-edit.md"), "3 edited there");
	assert.equal(files["edit-vs-del.md"], "4 edited here");
});

test("if main moves mid-push, it retries on top and loses nothing", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "a.md": "A", "b.md": "B" });
	const { disk, engine } = device(gh, "phone");
	await engine.sync("full");
	disk.put("a.md", "A phone");
	gh.beforeMainUpdate = () => gh.edit({ "b.md": "B agent" });
	await engine.sync("full");
	assert.deepEqual(gh.files(), { "a.md": "A phone", "b.md": "B agent" });
	assert.equal(disk.get("b.md"), "B agent");
});

test("excluded paths are never uploaded or deleted, even if they were synced before", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "a.md": "A", "code/readme.md": "from before" });
	const { disk, engine, state } = device(gh, "phone");
	disk.excluded = () => false;
	await engine.sync("full");
	assert.ok(state.base["code/readme.md"]);
	disk.excluded = (p) => p.startsWith("code/");
	disk.files.delete("code/readme.md");
	disk.put("code/.git/config", "secret stuff");
	await engine.sync("full");
	assert.equal(gh.files()["code/readme.md"], "from before");
	assert.equal(gh.files()["code/.git/config"], undefined);
});

test("refuses to upload a file containing the login token", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "a.md": "A" });
	const { disk, engine } = device(gh, "phone");
	await engine.sync("full");
	disk.put("leak.md", "oops gho_SECRETTOKEN123");
	await assert.rejects(engine.sync("full"), /login token/);
	assert.equal(gh.files()["leak.md"], undefined);
});

test("refuses a mass delete caused by an empty scan", async () => {
	const gh = new FakeGitHub();
	const many: Record<string, string> = {};
	for (let i = 0; i < 40; i++) many[`n${i}.md`] = `${i}`;
	await gh.seed(many);
	const { disk, engine } = device(gh, "phone");
	await engine.sync("full");
	disk.files.clear();
	await assert.rejects(engine.sync("full"), /Refusing to delete 40/);
	assert.equal(Object.keys(gh.files()).length, 40);
});

test("a big first upload sends text inside a few tree requests, and only binaries one by one", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine } = device(gh, "mac");
	for (let i = 0; i < 1200; i++) disk.put(`notes/n${i}.md`, `note ${i}\n`);
	disk.files.set("pic.png", { data: new Uint8Array([0x89, 0x50, 0xff, 0x00, 0xfe]), mtime: 0 });
	disk.put("bom.md", "\ufeffstarts with a BOM");
	const progress: string[] = [];
	(engine as any).opts.progress = (m: string) => progress.push(m);
	const r = await engine.sync("full");
	assert.equal(r.pushed.length, 1202);
	assert.equal(gh.blobUploads, 1, "only the binary file is uploaded on its own");
	assert.equal(gh.treeCalls, 4, "1201 text files in batches of 500, then one for the attachment");
	const files = gh.files();
	assert.equal(files["notes/n1199.md"], "note 1199\n");
	assert.equal(files["bom.md"], "\ufeffstarts with a BOM");
	assert.ok(progress.includes("uploading 1201 of 1201"));
	assert.ok(progress.includes("uploading attachment 1 of 1 (pic.png, 5 B)"));
});

test("if GitHub stores inline text differently, those files are re-sent byte-for-byte", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine } = device(gh, "mac");
	disk.put("crlf.md", "line one\r\nline two\r\n");
	disk.put("plain.md", "plain\n");
	gh.mangle = (s) => s.replace(/\r\n/g, "\n");
	await engine.sync("full");
	assert.equal(gh.files()["crlf.md"], "line one\r\nline two\r\n");
	assert.equal(gh.files()["plain.md"], "plain\n");
	assert.equal(gh.blobUploads, 1);
});

test("losing the connection mid-download stops cleanly and the next sync finishes the job", async () => {
	const gh = new FakeGitHub();
	const files: Record<string, string> = {};
	for (let i = 0; i < 30; i++) files[`n${i}.md`] = `note ${i}`;
	await gh.seed(files);
	const { disk, engine } = device(gh, "phone");
	const getBlob = gh.getBlob.bind(gh);
	let calls = 0;
	gh.getBlob = async (sha) => {
		if (++calls === 10) throw Object.assign(new Error("network down"), { name: "NetworkError" });
		return getBlob(sha);
	};
	await assert.rejects(engine.sync("full"), /network down/);
	const written = disk.files.size;
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(disk.files.size, written, "nothing keeps writing after the sync reported failure");
	assert.ok(written < 30);

	disk.put("offline-edit.md", "written while offline");
	await engine.sync("full");
	assert.equal(disk.files.size, 31);
	assert.equal(gh.files()["offline-edit.md"], "written while offline");
});

test("a file GitHub refuses is reported and retried later; everything else still syncs", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine, state } = device(gh, "mac");
	disk.put("note.md", "text");
	disk.files.set("big.pdf", { data: new Uint8Array([0xff, 0xfe, 0x00, 1, 2, 3]), mtime: 0 });
	disk.files.set("small.png", { data: new Uint8Array([0x89, 0x00, 0xff]), mtime: 0 });
	const createBlob = gh.createBlob.bind(gh);
	let refuse = true;
	gh.createBlob = async (data) => {
		if (refuse && data.length === 6) throw new Error("GitHub 401 Unauthorized on POST /git/blobs: Bad credentials");
		return createBlob(data);
	};
	const r = await engine.sync("full");
	assert.deepEqual(r.failed.map((f) => f.path), ["big.pdf"]);
	assert.match(r.failed[0].error, /^Couldn't sync attachment "big\.pdf" \(6 B\): GitHub 401 Unauthorized on POST \/git\/blobs: Bad credentials$/);
	assert.deepEqual(Object.keys(gh.files()).sort(), ["README.md", "note.md", "small.png"]);
	assert.equal(state.base["big.pdf"], undefined, "still pending");

	refuse = false;
	const r2 = await engine.sync("full");
	assert.deepEqual(r2.failed, []);
	assert.ok(gh.files()["big.pdf"] !== undefined);
});

test("a connection drop during file uploads still stops the sync", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine } = device(gh, "mac");
	disk.files.set("a.png", { data: new Uint8Array([0x89, 0x00, 0xff]), mtime: 0 });
	const down = () => {
		const e = new Error("Couldn't reach GitHub");
		e.name = "NetworkError";
		throw e;
	};
	gh.createBlob = async () => {
		gh.getHead = async () => down();
		return down();
	};
	await assert.rejects(engine.sync("full"), /Couldn't reach GitHub/);
	assert.deepEqual(Object.keys(gh.files()), ["README.md"]);
});

test("notes go in one commit, then each attachment in its own commit, smallest first", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine, state } = device(gh, "mac");
	disk.put("a.md", "A");
	disk.put("b.md", "B");
	disk.files.set("big.webm", { data: new Uint8Array(5000).fill(0xff), mtime: 0 });
	disk.files.set("small.png", { data: new Uint8Array([0x89, 0x00, 0xff]), mtime: 0 });
	const r = await engine.sync("full");

	const messages: string[] = [];
	for (let c = gh.refs.get("main")!; gh.commits.get(c)!.parents.length; c = gh.commits.get(c)!.parents[0]) {
		messages.unshift(gh.commits.get(c)!.message);
	}
	assert.equal(messages.length, 3);
	assert.match(messages[0], /^mac: a\.md, b\.md\n/);
	assert.equal(messages[1], "mac: attachment small.png (3 B)\n\nadded: small.png\n\nAttachment: small.png\n");
	assert.equal(messages[2], "mac: attachment big.webm (5 KB)\n\nadded: big.webm\n\nAttachment: big.webm\n");
	assert.equal(r.commit, gh.refs.get("main"));
	assert.equal(r.pushed.length, 4);
	assert.equal(gh.refs.get("sync/mac"), gh.refs.get("main"));
	assert.ok(state.base["big.webm"]);

	// Nothing left to do afterwards.
	const again = await engine.sync("full");
	assert.equal(again.commit, null);
});

test("if someone pushes during attachment uploads, the attachment goes on top of theirs", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine } = device(gh, "mac");
	disk.files.set("pic.png", { data: new Uint8Array([0x89, 0x00, 0xff]), mtime: 0 });
	gh.beforeMainUpdate = () => gh.edit({ "agent.md": "from an agent" });
	await engine.sync("full");
	const files = gh.files();
	assert.equal(files["agent.md"], "from an agent");
	assert.ok(files["pic.png"] !== undefined);
	await engine.sync("full");
	assert.equal(disk.get("agent.md"), "from an agent");
});

test("an upload that times out while GitHub is still reachable fails only that file", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "README.md": "hi" });
	const { disk, engine } = device(gh, "mac");
	disk.put("note.md", "text");
	disk.files.set("slow.m4a", { data: new Uint8Array([0xff, 0xfb, 0x00]), mtime: 0 });
	gh.createBlob = async () => {
		const e = new Error("Couldn't reach GitHub for POST /git/blobs: no answer within 121 s");
		e.name = "NetworkError";
		throw e;
	};
	const r = await engine.sync("full");
	assert.deepEqual(r.failed.map((f) => f.path), ["slow.m4a"]);
	assert.equal(gh.files()["note.md"], "text");
});

test("a file this device can't save is reported; everything else still syncs", async () => {
	const gh = new FakeGitHub();
	await gh.seed({ "ok.md": "fine", "Meeting 10:30.md": "colon", "big.md": "disk full" });
	const disk = new FakeDisk();
	(disk as any).nameProblem = (p: string) => (p.includes(":") ? 'its name contains ":", which Android doesn\'t allow in file names' : null);
	const write = disk.write.bind(disk);
	disk.write = async (p, d) => {
		if (p === "big.md") throw new Error("No space left on device");
		return write(p, d);
	};
	const { engine, state } = device(gh, "phone", disk);
	let blobs = 0;
	const getBlob = gh.getBlob.bind(gh);
	gh.getBlob = async (sha) => (blobs++, getBlob(sha));
	const r = await engine.sync("full");
	assert.equal(disk.get("ok.md"), "fine");
	assert.deepEqual(r.failed.map((f) => [f.path, f.direction]).sort(), [["Meeting 10:30.md", "down"], ["big.md", "down"]]);
	assert.match(r.failed.find((f) => f.path === "Meeting 10:30.md")!.error, /can't be stored on this device: its name contains ":", which Android doesn't allow in file names\. Rename it on another device/);
	assert.match(r.failed.find((f) => f.path === "big.md")!.error, /^Couldn't save "big\.md" on this device: No space left on device$/);
	assert.equal(blobs, 2, "the unstorable name isn't even downloaded");
	assert.equal(state.base["Meeting 10:30.md"], undefined);

	// Nothing is deleted on GitHub because of it.
	disk.put("new.md", "x");
	await engine.sync("full");
	assert.equal(gh.files()["Meeting 10:30.md"], "colon");
	assert.equal(gh.files()["new.md"], "x");
});
