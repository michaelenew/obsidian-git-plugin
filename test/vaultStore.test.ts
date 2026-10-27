import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultStore } from "../src/vaultStore";

/** A fake vault folder on disk: path -> contents (folders implied). */
function fakeApp(files: Record<string, string>) {
	const paths = Object.keys(files);
	const children = (dir: string) => {
		const prefix = dir === "" ? "" : dir + "/";
		const f = new Set<string>(), d = new Set<string>();
		for (const p of paths) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length).split("/");
			(rest.length === 1 ? f : d).add(prefix + rest[0]);
		}
		return { files: [...f], folders: [...d] };
	};
	const adapter = {
		list: async (dir: string) => children(dir === "/" ? "" : dir),
		exists: async (p: string) => p in files,
		read: async (p: string) => files[p],
		stat: async (p: string) => ({ mtime: 1, size: files[p].length }),
	};
	return { vault: { adapter, configDir: ".obsidian", getAbstractFileByPath: () => null } } as any;
}

test("skips nested repos, config, trash and gitignored files", async () => {
	const app = fakeApp({
		"note.md": "", "img/pic.png": "", ".gitignore": "*.tmp\nprivate/\n", "x.tmp": "", "private/a.md": "",
		"projects/tool/.git/HEAD": "", "projects/tool/README.md": "", "projects/tool/src/a.ts": "",
		"projects/notes.md": "", "work/sub/.git": "gitdir: elsewhere", "work/sub/doc.md": "",
		".obsidian/app.json": "", ".obsidian/plugins/simple-git-sync/data.json": "", ".trash/old.md": "",
		".git/config": "", "a/.DS_Store": "",
	});
	const store = new VaultStore(app, () => ({ includeConfigDir: false, extraIgnore: "", pluginDir: ".obsidian/plugins/simple-git-sync" }), () => {});
	const listed = (await store.list()).map((e) => e.path).sort();
	assert.deepEqual(listed, [".gitignore", "img/pic.png", "note.md", "projects/notes.md"]);
	// Remote paths inside a nested repo are skipped too.
	assert.ok(store.isExcluded("projects/tool/NEW.md"));
	assert.ok(!store.isExcluded("projects/other.md"));
});

test("config folder opt-in still never includes this plugin's folder or layout files", async () => {
	const app = fakeApp({
		".obsidian/app.json": "", ".obsidian/workspace.json": "", ".obsidian/workspace-mobile.json": "",
		".obsidian/plugins/simple-git-sync/data.json": "", ".obsidian/plugins/other/main.js": "",
	});
	const store = new VaultStore(app, () => ({ includeConfigDir: true, extraIgnore: "", pluginDir: ".obsidian/plugins/simple-git-sync" }), () => {});
	const listed = (await store.list()).map((e) => e.path).sort();
	assert.deepEqual(listed, [".obsidian/app.json", ".obsidian/plugins/other/main.js"]);
});

test("on Android, names with characters it forbids are flagged", async () => {
	const { Platform } = await import("obsidian");
	Object.assign(Platform, { isMobile: true, isAndroidApp: true });
	try {
		const store = new VaultStore(fakeApp({}), () => ({ includeConfigDir: false, extraIgnore: "", pluginDir: ".obsidian/plugins/simple-git-sync" }), () => {});
		assert.equal(store.nameProblem("notes/Plan: v2?.md"), 'its name contains ":" "?", which Android doesn\'t allow in file names');
		assert.equal(store.nameProblem("photos/Hawaii /a.jpg"), null);
	} finally {
		Object.assign(Platform, { isMobile: false, isAndroidApp: false });
	}
});
