import ignore, { Ignore } from "ignore";
import { App, normalizePath, Platform, TFile, TFolder } from "obsidian";
import type { LocalEntry, LocalStore } from "./engine";

export interface VaultStoreOptions {
	includeConfigDir: boolean;
	extraIgnore: string;
	/** This plugin's own folder. Never synced: it holds per-device state. */
	pluginDir: string;
}

/**
 * The vault as the sync engine sees it. Skips, on both sides:
 *  - any folder that is its own git repository (has a .git inside), wholesale
 *  - .git, .trash, .DS_Store
 *  - Obsidian's config folder (opt-in), and always this plugin's folder and
 *    the per-device workspace layout files
 *  - anything matched by the vault's root .gitignore or the extra patterns
 */
export class VaultStore implements LocalStore {
	private nestedRepos: string[] = [];
	private ig: Ignore = ignore();

	constructor(
		private app: App,
		private opts: () => VaultStoreOptions,
		private onWrite: (path: string) => void,
	) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	isExcluded(path: string, isDir = false): boolean {
		const segs = path.split("/");
		const name = segs[segs.length - 1];
		if (segs.includes(".git") || segs[0] === ".trash" || name === ".DS_Store") return true;

		const { includeConfigDir, pluginDir } = this.opts();
		const config = this.app.vault.configDir;
		if (segs[0] === config) {
			if (!includeConfigDir) return true;
			if (path === pluginDir || path.startsWith(pluginDir + "/")) return true;
			if (segs.length === 2 && /^workspace.*\.json$|^workspaces\.json$/.test(name)) return true;
		}
		for (const repo of this.nestedRepos) {
			if (path === repo || path.startsWith(repo + "/")) return true;
		}
		try {
			return this.ig.ignores(isDir ? path + "/" : path);
		} catch {
			return false;
		}
	}

	/** Android, iOS and Windows don't allow these in file or folder names; macOS and GitHub do. */
	nameProblem(path: string): string | null {
		if (!(Platform.isMobile || Platform.isWin)) return null;
		const bad = [...new Set([...path.replace(/\//g, "")].filter((ch) => '*"\\<>:|?'.includes(ch)))];
		if (!bad.length) return null;
		const system = Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iOS" : Platform.isWin ? "Windows" : "this device";
		return `its name contains ${bad.map((c) => `"${c}"`).join(" ")}, which ${system} doesn't allow in file names`;
	}

	async list(): Promise<LocalEntry[]> {
		const ig = ignore();
		if (await this.adapter.exists(".gitignore")) ig.add(await this.adapter.read(".gitignore"));
		ig.add(this.opts().extraIgnore);
		this.ig = ig;
		this.nestedRepos = [];

		const out: LocalEntry[] = [];
		const walk = async (dir: string): Promise<void> => {
			const listing = dir === "" ? await this.adapter.list("/").catch(() => this.adapter.list("")) : await this.adapter.list(dir);
			const files = listing.files.map(clean);
			const folders = listing.folders.map(clean);
			if (dir !== "" && [...files, ...folders].some((p) => p.split("/").pop() === ".git")) {
				this.nestedRepos.push(dir);
				return;
			}
			for (const path of files) {
				if (this.isExcluded(path)) continue;
				out.push({ path, ...(await this.stat(path)) });
			}
			for (const path of folders) {
				if (!this.isExcluded(path, true)) await walk(path);
			}
		};
		await walk("");
		return out;
	}

	private async stat(path: string): Promise<{ mtime: number; size: number }> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return { mtime: f.stat.mtime, size: f.stat.size };
		const s = await this.adapter.stat(path);
		if (!s) throw new Error(`Could not read ${path}`);
		return { mtime: s.mtime, size: s.size };
	}

	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.adapter.readBinary(path));
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(path);
	}

	async write(path: string, data: Uint8Array): Promise<void> {
		this.onWrite(path);
		const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.ensureFolder(path.slice(0, slash));
		const f = this.app.vault.getAbstractFileByPath(path);
		// Going through the vault (not the raw adapter) keeps open editors and
		// the file list up to date, which matters on mobile.
		if (f instanceof TFile) await this.app.vault.modifyBinary(f, buf);
		else if (isHidden(path) || (await this.adapter.exists(path))) await this.adapter.writeBinary(path, buf);
		else await this.app.vault.createBinary(path, buf);
	}

	async remove(path: string): Promise<void> {
		this.onWrite(path);
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.fileManager.trashFile(f);
		else await this.adapter.trashLocal(path);
	}

	private async ensureFolder(dir: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(dir) instanceof TFolder || (await this.adapter.exists(dir))) return;
		const slash = dir.lastIndexOf("/");
		if (slash > 0) await this.ensureFolder(dir.slice(0, slash));
		if (isHidden(dir)) await this.adapter.mkdir(dir);
		else await this.app.vault.createFolder(dir).catch(() => this.adapter.mkdir(dir));
	}
}

function clean(p: string): string {
	return normalizePath(p).replace(/^\/+/, "");
}

function isHidden(path: string): boolean {
	return path.split("/").some((s) => s.startsWith("."));
}
