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
	/** Why this path can't exist on this device (e.g. a character Android forbids), or null. */
	nameProblem?(path: string): string | null;
}

export interface RemoteEntry {
	sha: string;
	mode: string;
	/** bytes, when GitHub says */
	size?: number;
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
	/** Text to store for this path, sent inside the tree request (so no separate upload); its id must equal sha. */
	content?: string;
}

export interface RemoteStore {
	getHead(branch: string): Promise<string>;
	getTree(commit: string): Promise<RemoteTree>;
	getBlob(sha: string): Promise<Uint8Array>;
	createBlob(data: Uint8Array): Promise<string>;
	createTree(baseTree: string, changes: TreeChange[]): Promise<string>;
	/** Every file in a tree, by path. */
	listTree(treeSha: string): Promise<Map<string, RemoteEntry>>;
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
	/** Files GitHub wouldn't take this time; everything else was synced. Retried next sync. */
	failed: SyncFailure[];
	/** A pull that found nothing new on GitHub and didn't look at files at all */
	unchanged?: boolean;
}

/** A non-text file (or a text file over 1 MB) waiting to be pushed in its own commit. */
interface Attachment {
	change: TreeChange;
	kind: ChangeKind;
	/** Not the data itself: holding every attachment in memory at once crashed phones. */
	size: number;
	/** GitHub's version when this sync started; if it changes before we push, we back off */
	remoteSha: string | undefined;
}

interface Head {
	commit: string;
	treeSha: string;
}

export type HeavyAction = "reading" | "downloading" | "uploading";

/** Files at least this big are reported to onHeavy. */
export const HEAVY_FILE = 1024 * 1024;

export interface SyncFailure {
	path: string;
	error: string;
	/** "up": couldn't be sent to GitHub; "down": couldn't be saved on this device */
	direction: "up" | "down";
}

/** Errors that mean "stop the whole sync", as opposed to "this one file failed". */
const FATAL_ERRORS = new Set(["NetworkError", "AuthError", "StoppedError"]);

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
	/** Short progress text for long syncs, e.g. "uploading 120 of 400" */
	progress?: (msg: string) => void;
	/**
	 * Roughly how many bytes of files to handle at once. Phones have little memory, and
	 * on mobile every file crosses into the app as text several times its size.
	 */
	memoryBudget?: number;
	/** Don't download files bigger than this to this device (bytes); null for no limit. */
	maxDownloadSize?: number | null;
	/**
	 * Told (and awaited) just before and after work on a big file, so that if the app is
	 * killed mid-way (out of memory on a phone), the next start knows which file it was.
	 */
	onHeavy?: (starting: boolean, action: HeavyAction, path: string, size: number) => Promise<void>;
	/** Report files from this size up to onHeavy (default HEAVY_FILE; 0 reports every file) */
	heavyThreshold?: number;
	/** How many files to read at once when checking for changes (default 16) */
	scanConcurrency?: number;
}

const MAX_ATTEMPTS = 4;
const CONCURRENCY = 4;
// Notes (and deletions) go in one commit, sent as text inside the tree
// request, hundreds per request. Attachments then follow one commit each, so
// a problem file never holds up notes, and each one is easy to find or strip
// from history later (their messages end with an "Attachment: <path>" line).
const INLINE_MAX_FILE = 1024 * 1024;
const TREE_BATCH_BYTES = 4 * 1024 * 1024;
const TREE_BATCH_FILES = 500;
// GitHub refuses files over 100 MB.
const MAX_FILE = 100 * 1024 * 1024;

export class SyncEngine {
	private treeCache: { commit: string; tree: RemoteTree } | null = null;
	/** files read during the last scan because their size or date changed */
	private rehashed = 0;
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

	/** Run fn, telling onHeavy before and after if the file is big. */
	private async heavy<T>(action: HeavyAction, path: string, size: number, fn: () => Promise<T>): Promise<T> {
		const report = size >= (this.opts.heavyThreshold ?? HEAVY_FILE) ? this.opts.onHeavy : undefined;
		await report?.(true, action, path, size);
		try {
			return await fn();
		} finally {
			await report?.(false, action, path, size);
		}
	}

	private budget(): number {
		return this.opts.memoryBudget ?? 64 * 1024 * 1024;
	}

	async sync(mode: Mode): Promise<SyncResult> {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const pass = await this.attempt(mode);
			if (!pass) {
				this.log(`${this.opts.branch} moved while pushing; retrying (${attempt}/${MAX_ATTEMPTS})`);
				continue;
			}
			if (pass.attachments.length) await this.pushAttachments(pass.attachments, pass.head, pass.result);
			return pass.result;
		}
		throw new Error(`${this.opts.branch} kept changing while pushing; will try again later`);
	}

	/**
	 * Local changes not yet on GitHub, for display. Reads no files: a file whose size or
	 * date changed since it was last checked counts as changed. (Reading everything here,
	 * alongside a sync doing the same, used too much memory on phones.)
	 */
	async pendingChanges(): Promise<Change[]> {
		const entries = await this.local.list();
		const changes: Change[] = [];
		const present = new Set<string>();
		for (const e of entries) {
			present.add(e.path);
			const b = this.state.base[e.path];
			const hit = this.state.shaCache[e.path];
			const sha = hit && hit.mtime === e.mtime && hit.size === e.size ? hit.sha : null;
			if (b === undefined) changes.push({ path: e.path, kind: "added" });
			else if (sha !== b) changes.push({ path: e.path, kind: "modified" });
		}
		for (const path of Object.keys(this.state.base)) {
			if (!present.has(path) && !this.local.isExcluded(path)) changes.push({ path, kind: "deleted" });
		}
		return changes.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * One pass: pull, merge, and push notes in one commit. Returns null when
	 * main moved under us and the pass must be redone; otherwise the
	 * attachments still to push and the head to push them onto.
	 */
	private async attempt(mode: Mode): Promise<{ result: SyncResult; attachments: Attachment[]; head: Head } | null> {
		const head = await this.remote.getHead(this.opts.branch);
		const result: SyncResult = {
			mode, head, commit: null, pulled: [], pushed: [], merged: [], conflicts: [], skipped: [], failed: [],
		};
		if (mode === "pull" && head === this.settledHead) {
			result.unchanged = true;
			return { result, attachments: [], head: { commit: head, treeSha: "" } };
		}

		this.opts.progress?.("getting the file list from GitHub");
		const tree = await this.getTree(head);
		const local = await this.scanLocal();
		// Reading every file is the slow part; keep the result even if the app is killed later.
		if (this.rehashed > 20) await this.opts.saveState();
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
		const weights: number[] = [];
		// A file that can't be saved here (bad name, disk full, ...) is reported; the rest still syncs.
		const schedule = (path: string, task: () => Promise<void>) => {
			const size = remote.get(path)?.size ?? 0;
			weights.push(size);
			work.push(async () => {
				try {
					await this.heavy("downloading", path, size, task);
				} catch (e) {
					if (e instanceof Error && FATAL_ERRORS.has(e.name)) throw e;
					settled = false;
					const error = `Couldn't save "${path}" on this device: ${e instanceof Error ? e.message : e}`;
					this.log(error);
					result.failed.push({ path, error, direction: "down" });
				}
			});
		};
		const maxDownload = this.opts.maxDownloadSize;
		for (const path of paths) {
			if (this.local.isExcluded(path)) continue;
			const b = base[path];
			const l = local.get(path);
			const r = remote.get(path)?.sha;

			// Changed on GitHub but too big for this device: leave it there, keep the local copy.
			const size = remote.get(path)?.size ?? 0;
			if (r !== undefined && r !== b && l !== r && maxDownload && size > maxDownload) {
				result.failed.push({
					path,
					error: `"${path}" (${formatSize(size)}) is bigger than this device's download limit (${formatSize(maxDownload)}), so it stays on GitHub. You can raise the limit in Settings → Simple Git Sync.`,
					direction: "down",
				});
				continue;
			}

			// Can never exist on this device: say so once per sync, don't download it.
			const problem = l === undefined && r !== undefined ? this.local.nameProblem?.(path) : null;
			if (problem) {
				result.failed.push({
					path,
					error: `"${path}" can't be stored on this device: ${problem}. Rename it on another device to sync it here; it is safe on GitHub.`,
					direction: "down",
				});
				continue;
			}

			if (l === r) {
				setBase(path, r);
			} else if (l === b) {
				// Only GitHub changed it.
				schedule(path, async () => {
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
				schedule(path, async () => {
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
				schedule(path, async () => {
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
		let done = 0;
		await runLimited(
			work.map((w) => async () => {
				await w();
				if (work.length > 10) this.opts.progress?.(`downloading ${++done} of ${work.length}`);
			}),
			CONCURRENCY,
			this.budget(),
			weights,
		);

		const { changes, attachments } =
			mode === "full" && toPush.size > 0 ? await this.prepareUpload(toPush, remote, result) : { changes: [], attachments: [] };
		if (changes.length === 0) {
			this.state.lastCommit = head;
			this.settledHead = settled ? head : null;
			await this.opts.saveState();
			return { result, attachments, head: { commit: head, treeSha: tree.treeSha } };
		}

		const treeSha = await this.buildTree(tree.treeSha, changes.map((c) => c.change));
		const commit = await this.remote.createCommit(this.commitMessage(changes), treeSha, [head]);
		if (!(await this.publish(commit))) {
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
		return { result, attachments, head: { commit, treeSha } };
	}

	/** Point the device branch and then main at commit. False if main moved meanwhile. */
	private async publish(commit: string): Promise<boolean> {
		if (this.opts.deviceBranch) await this.remote.updateRef(this.opts.deviceBranch, commit, true);
		return this.remote.updateRef(this.opts.branch, commit, false);
	}

	/** One commit per attachment, smallest first. A failure is reported for that file only. */
	private async pushAttachments(attachments: Attachment[], head: Head, result: SyncResult): Promise<void> {
		attachments.sort((a, b) => a.size - b.size);
		let n = 0;
		for (const a of attachments) {
			const { path } = a.change;
			const size = formatSize(a.size);
			this.opts.progress?.(`uploading attachment ${++n} of ${attachments.length} (${path.split("/").pop()}, ${size})`);
			try {
				const next = await this.pushAttachment(a, head, result);
				if (!next) continue;
				head = next;
				result.commit = head.commit;
				result.pushed.push({ path, kind: a.kind });
				this.log(`pushed ${head.commit.slice(0, 7)} (attachment ${path}, ${size})`);
			} catch (e) {
				if (e instanceof Error && (e.name === "AuthError" || e.name === "StoppedError")) throw e;
				// A dropped connection or timeout: if GitHub still answers, it was this file, not the connection.
				if (e instanceof Error && e.name === "NetworkError") {
					await this.remote.getHead(this.opts.branch).catch(() => {
						throw e;
					});
				}
				const error = `Couldn't sync attachment "${path}" (${size}): ${e instanceof Error ? e.message : e}`;
				this.log(error);
				result.failed.push({ path, error, direction: "up" });
			}
		}
	}

	/** Returns the new head, or null if the file changed on GitHub meanwhile (merged next sync). */
	private async pushAttachment(a: Attachment, head: Head, result: SyncResult): Promise<Head | null> {
		const { path, sha } = a.change;
		// Read now, one attachment at a time. If it changed since the scan, the next sync sends it.
		const sent = await this.heavy("uploading", path, a.size, async () => {
			const data = await this.local.read(path);
			if ((await gitBlobSha(data)) !== sha) return false;
			await this.uploadBlob(path, data, sha!);
			return true;
		});
		if (!sent) {
			result.skipped.push(path);
			return null;
		}
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const treeSha = await this.remote.createTree(head.treeSha, [{ path, mode: a.change.mode, sha }]);
			const name = path.split("/").pop();
			const message = `${this.opts.deviceName}: attachment ${name} (${formatSize(a.size)})\n\n${a.kind}: ${path}\n\nAttachment: ${path}\n`;
			const commit = await this.remote.createCommit(message, treeSha, [head.commit]);
			if (await this.publish(commit)) {
				this.state.base[path] = sha!;
				this.state.lastCommit = commit;
				if (this.settledHead === head.commit) this.settledHead = commit;
				await this.opts.saveState();
				return { commit, treeSha };
			}
			// Someone pushed meanwhile: go on top of theirs, unless they changed this very file.
			const latest = await this.remote.getHead(this.opts.branch);
			const tree = await this.getTree(latest);
			this.settledHead = null;
			if (tree.entries.get(path)?.sha !== a.remoteSha) {
				result.skipped.push(path);
				return null;
			}
			head = { commit: latest, treeSha: tree.treeSha };
		}
		throw new Error(`${this.opts.branch} kept changing while pushing`);
	}

	private async prepareUpload(
		paths: Set<string>,
		remote: Map<string, RemoteEntry>,
		result: SyncResult,
	): Promise<{ changes: Array<{ change: TreeChange; kind: ChangeKind }>; attachments: Attachment[] }> {
		const out: Array<{ change: TreeChange; kind: ChangeKind }> = [];
		const attachments: Attachment[] = [];
		const forbidden = (this.opts.forbidden?.() ?? []).filter((s) => s.length >= 8);

		await runLimited(
			[...paths].map((path) => async () => {
				const r = remote.get(path);
				if (!(await this.local.exists(path))) {
					if (r) out.push({ change: { path, mode: r.mode, sha: null }, kind: "deleted" });
					return;
				}
				const data = await this.heavy("reading", path, this.state.shaCache[path]?.size ?? 0, () => this.local.read(path));
				const sha = await gitBlobSha(data);
				if (r?.sha === sha) return;
				if (forbidden.length) {
					const text = new TextDecoder("utf-8").decode(data);
					if (forbidden.some((s) => text.includes(s))) {
						throw new Error(`Refusing to upload "${path}": it contains your GitHub login token. Delete the token from that file.`);
					}
				}
				const change: TreeChange = { path, mode: r?.mode ?? "100644", sha };
				const kind = r ? "modified" : "added";
				const text = data.length <= INLINE_MAX_FILE ? exactText(data) : null;
				if (text !== null) {
					change.content = text;
					out.push({ change, kind });
				} else if (data.length > MAX_FILE) {
					const error = `Couldn't sync "${path}" (${formatSize(data.length)}): GitHub doesn't accept files over 100 MB`;
					this.log(error);
					result.failed.push({ path, error, direction: "up" });
				} else {
					attachments.push({ change, kind, size: data.length, remoteSha: r?.sha });
				}
			}),
			CONCURRENCY * 4,
			this.budget(),
			[...paths].map((p) => this.state.shaCache[p]?.size ?? 0),
		);

		// A scan that silently missed files would look like a mass delete; refuse that.
		const deleted = out.filter((c) => c.kind === "deleted").length;
		const tracked = Object.keys(this.state.base).length;
		if (deleted > 20 && deleted > tracked / 2) {
			throw new Error(`Refusing to delete ${deleted} of ${tracked} files on GitHub in one sync. If this is intended, delete them on GitHub directly.`);
		}
		return { changes: out.sort((a, b) => a.change.path.localeCompare(b.change.path)), attachments };
	}

	private async uploadBlob(path: string, data: Uint8Array, sha: string) {
		const blob = await this.remote.createBlob(data);
		if (blob !== sha) throw new Error(`GitHub stored "${path}" with an unexpected id; aborting`);
	}

	/** Add changes to baseTree in batches, then check GitHub stored every inline text exactly. */
	private async buildTree(baseTree: string, changes: TreeChange[]): Promise<string> {
		const batches: TreeChange[][] = [[]];
		let bytes = 0;
		for (const c of changes) {
			const size = c.content?.length ?? 0;
			const last = batches[batches.length - 1];
			if (last.length && (last.length >= TREE_BATCH_FILES || bytes + size > TREE_BATCH_BYTES)) {
				batches.push([]);
				bytes = 0;
			}
			batches[batches.length - 1].push(c);
			bytes += size;
		}
		let tree = baseTree;
		let sent = 0;
		for (const batch of batches) {
			tree = await this.remote.createTree(tree, batch);
			sent += batch.length;
			if (changes.length > 10) this.opts.progress?.(`uploading ${sent} of ${changes.length}`);
		}

		const inline = changes.filter((c) => c.content !== undefined);
		if (!inline.length) return tree;
		const stored = await this.remote.listTree(tree);
		const wrong = inline.filter((c) => stored.get(c.path)?.sha !== c.sha);
		if (!wrong.length) return tree;
		// Shouldn't happen; if GitHub altered any text, send those files byte-for-byte instead.
		this.log(`re-uploading ${wrong.length} files GitHub stored differently`);
		for (const c of wrong) await this.uploadBlob(c.path, new TextEncoder().encode(c.content!), c.sha!);
		return this.remote.createTree(tree, wrong.map((c) => ({ path: c.path, mode: c.mode, sha: c.sha })));
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
		this.opts.progress?.("listing files on this device");
		const entries = await this.local.list();
		const cache = this.state.shaCache;
		const fresh: SyncState["shaCache"] = {};
		const out = new Map<string, string>();
		const cached = (e: LocalEntry) => {
			const hit = cache[e.path];
			return hit && hit.mtime === e.mtime && hit.size === e.size ? hit.sha : null;
		};
		this.rehashed = 0;
		let checked = 0;
		const toCheck = entries.filter((e) => cached(e) === null).length;
		if (toCheck) this.opts.progress?.(`checking ${toCheck} changed files`);
		await runLimited(
			entries.map((e) => async () => {
				let sha = cached(e);
				if (sha === null) {
					sha = await this.heavy("reading", e.path, e.size, async () => gitBlobSha(await this.local.read(e.path)));
					this.rehashed++;
					if (toCheck > 10) this.opts.progress?.(`checking file ${++checked} of ${toCheck}`);
				}
				fresh[e.path] = { mtime: e.mtime, size: e.size, sha };
				out.set(e.path, sha);
			}),
			this.opts.scanConcurrency ?? CONCURRENCY * 4,
			this.budget(),
			entries.map((e) => (cached(e) === null ? e.size : 0)),
		);
		this.state.shaCache = fresh;
		return out;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The file as text, if it is UTF-8 that converts back to exactly the same bytes. */
function exactText(data: Uint8Array): string | null {
	const text = decodeText(data);
	if (text === null) return null;
	const back = new TextEncoder().encode(text);
	return back.length === data.length && back.every((b, i) => b === data[i]) ? text : null;
}

/**
 * Run tasks, at most `limit` at once and, when weights are given, at most `budget`
 * of weight (bytes) at once; a task heavier than the whole budget runs on its own.
 * On the first failure, start no new ones, let running ones finish, then throw.
 */
async function runLimited(tasks: Array<() => Promise<void>>, limit: number, budget = Infinity, weights?: number[]): Promise<void> {
	let next = 0;
	let running = 0;
	let inFlight = 0;
	let failure: { error: unknown } | null = null;
	await new Promise<void>((resolve) => {
		const pump = () => {
			while (!failure && next < tasks.length && running < limit) {
				const weight = weights?.[next] ?? 0;
				if (running > 0 && inFlight + weight > budget) break;
				const task = tasks[next++];
				running++;
				inFlight += weight;
				task()
					.catch((error) => {
						failure ??= { error };
					})
					.finally(() => {
						running--;
						inFlight -= weight;
						pump();
					});
			}
			if (running === 0 && (failure || next >= tasks.length)) resolve();
		};
		pump();
	});
	if (failure) throw (failure as { error: unknown }).error;
}
