import { decodeText, isTextPath, merge3 } from "./merge";
import { gitBlobSha } from "./sha";

/*
 * The sync engine. It never runs git; it compares three snapshots of the vault:
 *
 *   base   - what this device last agreed with GitHub (path -> blob id)
 *   local  - the files on this device right now
 *   remote - the files on the sync branch (usually main) right now
 *
 * For each path: if only one side changed since base, that side wins. If both
 * changed, text files are merged line-by-line (conflicting lines keep both
 * versions); other files keep both as separate files. Local changes are then
 * committed on top of the remote head and main is fast-forwarded to it. If
 * someone else moved main in the meantime, the whole thing reruns.
 */

export type Mode = "full" | "pull";

export interface LocalEntry {
	path: string;
	mtime: number;
	size: number;
}

export interface LocalStore {
	/** Every syncable file. Must throw rather than return a partial list. */
	list(): Promise<LocalEntry[]>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, data: Uint8Array): Promise<void>;
	/** Delete (to trash, where the platform allows). */
	remove(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Paths this device never touches, on either side. Valid after list(). */
	isExcluded(path: string): boolean;
}

export interface RemoteEntry {
	sha: string;
	mode: string;
}

export interface RemoteTree {
	treeSha: string;
	entries: Map<string, RemoteEntry>;
}

export interface TreeChange {
	path: string;
	mode: string;
	/** null deletes the path */
	sha: string | null;
}

export interface RemoteStore {
	getHead(branch: string): Promise<string>;
	getTree(commit: string): Promise<RemoteTree>;
	getBlob(sha: string): Promise<Uint8Array>;
	createBlob(data: Uint8Array): Promise<string>;
	createTree(baseTree: string, changes: TreeChange[]): Promise<string>;
	createCommit(message: string, tree: string, parents: string[]): Promise<string>;
	/** Create or move a branch. Returns false if a non-forced move is not a fast-forward. */
	updateRef(branch: string, sha: string, force: boolean): Promise<boolean>;
}

export interface SyncState {
	/** "owner/repo@branch" the base belongs to; a mismatch means start over */
	target: string;
	base: Record<string, string>;
	lastCommit: string | null;
	shaCache: Record<string, { mtime: number; size: number; sha: string }>;
}

export function emptyState(target: string): SyncState {
	return { target, base: {}, lastCommit: null, shaCache: {} };
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
	path: string;
	kind: ChangeKind;
}

export interface SyncResult {
	mode: Mode;
	head: string;
	commit: string | null;
	pulled: string[];
	pushed: Change[];
	merged: string[];
	/** files that now contain conflict markers, or conflict copies */
	conflicts: string[];
	/** remote changes held back because the local file changed mid-sync or (pull mode) also changed locally */
	skipped: string[];
}

export interface EngineOptions {
	branch: string;
	deviceName: string;
	/** Per-device branch that gets every commit before main does; null to skip */
	deviceBranch: string | null;
	state: SyncState;
	saveState: () => Promise<void>;
	/** Strings that must never be uploaded (the login token). */
	forbidden?: () => string[];
	now?: () => Date;
	log?: (msg: string) => void;
}

const MAX_ATTEMPTS = 4;
const CONCURRENCY = 4;

export class SyncEngine {
	private treeCache: { commit: string; tree: RemoteTree } | null = null;
	/** head whose changes are all already on this device; lets a pull with nothing new cost one request */
	private settledHead: string | null = null;

	constructor(
		private local: LocalStore,
		private remote: RemoteStore,
		private opts: EngineOptions,
	) {}

	private get state() {
		return this.opts.state;
	}

	private log(msg: string) {
		this.opts.log?.(msg);
	}

	async sync(mode: Mode): Promise<SyncResult> {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const result = await this.attempt(mode);
			if (result) return result;
			this.log(`${this.opts.branch} moved while pushing; retrying (${attempt}/${MAX_ATTEMPTS})`);
		}
		throw new Error(`${this.opts.branch} kept changing while pushing; will try again later`);
	}

	/** Local changes not yet on GitHub. */
	async pendingChanges(): Promise<Change[]> {
		const local = await this.scanLocal();
		const changes: Change[] = [];
		for (const [path, sha] of local) {
			const b = this.state.base[path];
			if (b === undefined) changes.push({ path, kind: "added" });
			else if (b !== sha) changes.push({ path, kind: "modified" });
		}
		for (const path of Object.keys(this.state.base)) {
			if (!local.has(path) && !this.local.isExcluded(path)) changes.push({ path, kind: "deleted" });
		}
		return changes.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** One pass. Returns null when main moved under us and the pass must be redone. */
	private async attempt(mode: Mode): Promise<SyncResult | null> {
		const head = await this.remote.getHead(this.opts.branch);
		const result: SyncResult = {
			mode, head, commit: null, pulled: [], pushed: [], merged: [], conflicts: [], skipped: [],
		};
		if (mode === "pull" && head === this.settledHead) return result;

		const tree = await this.getTree(head);
		const local = await this.scanLocal();
		const remote = new Map<string, RemoteEntry>();
		for (const [path, entry] of tree.entries) {
			if (!this.local.isExcluded(path)) remote.set(path, entry);
		}

		const base = this.state.base;
		const setBase = (path: string, sha: string | undefined) => {
			if (sha === undefined) delete base[path];
			else base[path] = sha;
		};
		const paths = new Set([...Object.keys(base), ...local.keys(), ...remote.keys()]);
		const toPush = new Set<string>();
		let settled = true;

		const work: Array<() => Promise<void>> = [];
		for (const path of paths) {
			if (this.local.isExcluded(path)) continue;
			const b = base[path];
			const l = local.get(path);
			const r = remote.get(path)?.sha;

			if (l === r) {
				setBase(path, r);
			} else if (l === b) {
				// Only GitHub changed it.
				work.push(async () => {
					if (await this.applyRemote(path, l, r)) {
						setBase(path, r);
						result.pulled.push(path);
					} else {
						settled = false;
						result.skipped.push(path);
					}
				});
			} else if (r === b) {
				// Only this device changed it.
				toPush.add(path);
			} else if (mode === "pull") {
				// Both changed; leave it for the next full sync, which can push the merge.
				settled = false;
				result.skipped.push(path);
			} else if (l === undefined) {
				// Deleted here, edited elsewhere: keep the edit.
				work.push(async () => {
					if (await this.applyRemote(path, l, r)) {
						setBase(path, r);
						result.pulled.push(path);
					} else {
						settled = false;
						result.skipped.push(path);
					}
				});
			} else if (r === undefined) {
				// Edited here, deleted elsewhere: keep the edit.
				setBase(path, undefined);
				toPush.add(path);
			} else {
				work.push(async () => {
					const outcome = await this.mergeBoth(path, b, l, r);
					if (!outcome) {
						settled = false;
						result.skipped.push(path);
						return;
					}
					setBase(path, r);
					toPush.add(path);
					if (outcome.copyPath) {
						toPush.add(outcome.copyPath);
						result.conflicts.push(outcome.copyPath);
					} else if (outcome.conflict) {
						result.conflicts.push(path);
					} else {
						result.merged.push(path);
					}
				});
			}
		}
		await runLimited(work, CONCURRENCY);

		const changes = mode === "full" && toPush.size > 0 ? await this.prepareUpload(toPush, remote) : [];
		if (changes.length === 0) {
			this.state.lastCommit = head;
			this.settledHead = settled ? head : null;
			await this.opts.saveState();
			return result;
		}

		const commit = await this.remote.createCommit(
			this.commitMessage(changes),
			await this.remote.createTree(tree.treeSha, changes.map((c) => c.change)),
			[head],
		);
		if (this.opts.deviceBranch) await this.remote.updateRef(this.opts.deviceBranch, commit, true);
		if (!(await this.remote.updateRef(this.opts.branch, commit, false))) {
			// Pulled files are on disk and recorded in base, so the retry starts from there.
			await this.opts.saveState();
			return null;
		}

		for (const c of changes) setBase(c.change.path, c.change.sha ?? undefined);
		this.state.lastCommit = commit;
		this.settledHead = settled ? commit : null;
		await this.opts.saveState();
		result.commit = commit;
		result.pushed = changes.map((c) => ({ path: c.change.path, kind: c.kind }));
		this.log(`pushed ${commit.slice(0, 7)} (${changes.length} files)`);
		return result;
	}

	private async prepareUpload(
		paths: Set<string>,
		remote: Map<string, RemoteEntry>,
	): Promise<Array<{ change: TreeChange; kind: ChangeKind }>> {
		const out: Array<{ change: TreeChange; kind: ChangeKind }> = [];
		const forbidden = (this.opts.forbidden?.() ?? []).filter((s) => s.length >= 8);

		await runLimited(
			[...paths].map((path) => async () => {
				const r = remote.get(path);
				if (!(await this.local.exists(path))) {
					if (r) out.push({ change: { path, mode: r.mode, sha: null }, kind: "deleted" });
					return;
				}
				const data = await this.local.read(path);
				const sha = await gitBlobSha(data);
				if (r?.sha === sha) return;
				if (forbidden.length) {
					const text = new TextDecoder("utf-8").decode(data);
					if (forbidden.some((s) => text.includes(s))) {
						throw new Error(`Refusing to upload "${path}": it contains your GitHub login token. Delete the token from that file.`);
					}
				}
				const blob = await this.remote.createBlob(data);
				if (blob !== sha) throw new Error(`GitHub stored "${path}" with an unexpected id; aborting`);
				out.push({ change: { path, mode: r?.mode ?? "100644", sha }, kind: r ? "modified" : "added" });
			}),
			CONCURRENCY,
		);

		// A scan that silently missed files would look like a mass delete; refuse that.
		const deleted = out.filter((c) => c.kind === "deleted").length;
		const tracked = Object.keys(this.state.base).length;
		if (deleted > 20 && deleted > tracked / 2) {
			throw new Error(`Refusing to delete ${deleted} of ${tracked} files on GitHub in one sync. If this is intended, delete them on GitHub directly.`);
		}
		return out.sort((a, b) => a.change.path.localeCompare(b.change.path));
	}

	private commitMessage(changes: Array<{ change: TreeChange; kind: ChangeKind }>): string {
		const names = changes.map((c) => c.change.path.split("/").pop());
		const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? `, +${names.length - 3} more` : "");
		const body = changes.map((c) => `${c.kind}: ${c.change.path}`).join("\n");
		return `${this.opts.deviceName}: ${shown}\n\n${body}\n`;
	}

	/** Write GitHub's version (or delete) if the local file is still what we scanned. */
	private async applyRemote(path: string, expected: string | undefined, r: string | undefined): Promise<boolean> {
		if ((await this.currentSha(path)) !== expected) return false;
		if (r === undefined) await this.local.remove(path);
		else await this.local.write(path, await this.remote.getBlob(r));
		return true;
	}

	private async mergeBoth(
		path: string,
		b: string | undefined,
		l: string,
		r: string,
	): Promise<{ conflict: boolean; copyPath?: string } | null> {
		if ((await this.currentSha(path)) !== l) return null;
		const ours = await this.local.read(path);
		const theirs = await this.remote.getBlob(r);

		if (b !== undefined && isTextPath(path)) {
			const texts = [ours, await this.remote.getBlob(b), theirs].map(decodeText);
			if (texts.every((t) => t !== null)) {
				const [o, base, t] = texts as string[];
				const merged = merge3(o, base, t, `${this.opts.deviceName} (this device)`, `${this.opts.branch} on GitHub`);
				if ((await this.currentSha(path)) !== l) return null;
				await this.local.write(path, new TextEncoder().encode(merged.text));
				return { conflict: merged.conflict };
			}
		}

		// Can't merge: this device's version stays put, GitHub's goes next to it.
		const copyPath = await this.conflictPath(path);
		await this.local.write(copyPath, theirs);
		this.log(`kept both versions of ${path}; GitHub's is in ${copyPath}`);
		return { conflict: true, copyPath };
	}

	private async conflictPath(path: string): Promise<string> {
		const slash = path.lastIndexOf("/");
		const dir = path.slice(0, slash + 1);
		const name = path.slice(slash + 1);
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		const d = (this.opts.now ?? (() => new Date()))();
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
		for (let i = 1; ; i++) {
			const candidate = `${dir}${stem} (conflict ${stamp}${i > 1 ? ` ${i}` : ""})${ext}`;
			if (!(await this.local.exists(candidate))) return candidate;
		}
	}

	private async currentSha(path: string): Promise<string | undefined> {
		if (!(await this.local.exists(path))) return undefined;
		return gitBlobSha(await this.local.read(path));
	}

	private async getTree(commit: string): Promise<RemoteTree> {
		if (this.treeCache?.commit !== commit) {
			this.treeCache = { commit, tree: await this.remote.getTree(commit) };
		}
		return this.treeCache.tree;
	}

	/** path -> blob id for every local file, re-reading only files whose size or mtime changed. */
	private async scanLocal(): Promise<Map<string, string>> {
		const entries = await this.local.list();
		const cache = this.state.shaCache;
		const fresh: SyncState["shaCache"] = {};
		const out = new Map<string, string>();
		await runLimited(
			entries.map((e) => async () => {
				const hit = cache[e.path];
				const sha =
					hit && hit.mtime === e.mtime && hit.size === e.size
						? hit.sha
						: await gitBlobSha(await this.local.read(e.path));
				fresh[e.path] = { mtime: e.mtime, size: e.size, sha };
				out.set(e.path, sha);
			}),
			CONCURRENCY * 4,
		);
		this.state.shaCache = fresh;
		return out;
	}
}

async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) await tasks[next++]();
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}
