import { Notice, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import { Change, emptyState, Mode, SyncEngine, SyncResult, SyncState } from "./engine";
import { Auth, AuthError, Credentials } from "./auth";
import { GitHub } from "./github";
import { InstallModal, LoginModal, PANEL_VIEW, RepoPicker, SettingsTab, SyncPanel } from "./ui";
import { VaultStore } from "./vaultStore";

const TOKEN_ID = "simple-git-sync-github-token";

export interface Settings {
	repo: string;
	branch: string;
	username: string;
	deviceName: string;
	useDeviceBranch: boolean;
	includeConfigDir: boolean;
	extraIgnore: string;
	pullIntervalSec: number;
	idlePushSec: number;
	syncOnFileSwitch: boolean;
	/** The user's own GitHub App, created during setup. Kept per device, never synced or committed. */
	clientId: string;
	/** That app's short name in GitHub URLs, e.g. simple-git-sync-k3x9q */
	appSlug: string;
}

function defaultDeviceName(): string {
	const kind = Platform.isAndroidApp ? "android" : Platform.isIosApp ? "ios" : Platform.isMacOS ? "mac"
		: Platform.isWin ? "windows" : Platform.isLinux ? "linux" : "device";
	return `${kind}-${Math.random().toString(36).slice(2, 6)}`;
}

const DEFAULTS: Omit<Settings, "deviceName"> = {
	repo: "",
	branch: "",
	username: "",
	useDeviceBranch: true,
	includeConfigDir: false,
	extraIgnore: "",
	pullIntervalSec: 60,
	idlePushSec: 120,
	syncOnFileSwitch: true,
	clientId: "",
	appSlug: "",
};

export type Phase = "logged-out" | "no-repo" | "idle" | "syncing" | "error";

export interface Status {
	phase: Phase;
	message: string;
	lastSync: Date | null;
	lastResult: SyncResult | null;
	conflicts: string[];
	log: Array<{ at: Date; text: string }>;
}

export default class SimpleGitSync extends Plugin {
	settings!: Settings;
	private state!: SyncState;
	status: Status = { phase: "logged-out", message: "", lastSync: null, lastResult: null, conflicts: [], log: [] };

	private engine: SyncEngine | null = null;
	private running = false;
	private rerun: Mode | null = null;
	private timer: number | null = null;
	private timerDue = 0;
	private timerMode: Mode = "pull";
	private pullInterval: number | null = null;
	/** files edited since the last push */
	private dirty = new Set<string>();
	/** files the sync itself just wrote, so their change events aren't mistaken for edits */
	private selfWrites = new Map<string, number>();
	private activePath: string | null = null;
	private listeners = new Set<() => void>();
	private loginOpen = false;
	private lastLoginPrompt = 0;
	private repoPickAfterInstall = false;
	readonly auth = new Auth(() => this.credentials(), (c) => this.setCredentials(c), () => this.clientId());
	statusBar: HTMLElement | null = null;

	async onload() {
		const data = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULTS, deviceName: defaultDeviceName(), ...data.settings };
		this.state = data.state ?? emptyState(this.target());
		await this.save();

		this.registerView(PANEL_VIEW, (leaf) => new SyncPanel(leaf, this));
		this.addRibbonIcon("refresh-cw", "Git sync panel", () => this.openPanel());
		this.addSettingTab(new SettingsTab(this.app, this));
		if (!Platform.isMobile) {
			this.statusBar = this.addStatusBarItem();
			this.statusBar.addClass("mod-clickable");
			this.statusBar.onClickEvent(() => this.openPanel());
		}

		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow("full") });
		this.addCommand({ id: "pull-now", name: "Pull changes from GitHub", callback: () => this.syncNow("pull") });
		this.addCommand({ id: "open-panel", name: "Open sync panel", callback: () => this.openPanel() });
		this.addCommand({ id: "log-in", name: "Log in to GitHub", callback: () => this.login() });
		this.addCommand({ id: "choose-repo", name: "Choose repository", callback: () => this.chooseRepo() });

		this.app.workspace.onLayoutReady(() => {
			// Not earlier: while loading, Obsidian reports every file as newly created.
			this.registerTriggers();
			this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
			this.restartPullTimer();
			if (!this.loggedIn()) this.login();
			else if (!this.settings.repo) this.chooseRepo();
			else this.schedule("full", 0);
		});
		this.refresh();
	}

	onunload() {
		if (this.timer !== null) window.clearTimeout(this.timer);
	}

	// ---- triggers -------------------------------------------------------

	private registerTriggers() {
		const edited = (file: TAbstractFile, oldPath?: string) => {
			if (!(file instanceof TFile)) return;
			const written = this.selfWrites.get(file.path);
			if (written && Date.now() - written < 5000) return;
			this.dirty.add(file.path);
			if (oldPath) this.dirty.add(oldPath);
			// Fallback for long edits of one file: push at most this long after an edit.
			this.schedule("full", this.settings.idlePushSec * 1000);
			this.refresh();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => edited(f)));
		this.registerEvent(this.app.vault.on("create", (f) => edited(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => edited(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => edited(f, old)));

		// Leaving a file you changed (switching notes, closing the tab) pushes soon after.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				const left = this.activePath;
				this.activePath = file?.path ?? null;
				if (this.settings.syncOnFileSwitch && left && left !== this.activePath && this.dirty.has(left)) {
					this.schedule("full", 2000);
				}
			}),
		);

		// App sent to background (phone) or minimized: push now. Back in front: catch up.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				if (this.dirty.size) this.schedule("full", 0);
			} else if (this.repoPickAfterInstall && !this.settings.repo) {
				this.repoPickAfterInstall = false;
				void this.chooseRepo();
			} else if (!this.loggedIn()) {
				// Re-ask on return to the app, but not every time if the user keeps dismissing it.
				if (Date.now() - this.lastLoginPrompt > 30 * 60 * 1000) this.login();
			} else {
				this.schedule(this.dirty.size ? "full" : "pull", 0);
			}
		});
		// Desktop: switching to another app.
		if (!Platform.isMobile) {
			this.registerDomEvent(window, "blur", () => {
				if (this.dirty.size) this.schedule("full", 3000);
			});
		}
	}

	restartPullTimer() {
		if (this.pullInterval !== null) window.clearInterval(this.pullInterval);
		const ms = Math.max(15, this.settings.pullIntervalSec) * 1000;
		this.pullInterval = this.registerInterval(
			window.setInterval(() => {
				if (document.visibilityState === "visible") this.schedule("pull", 0);
			}, ms),
		);
	}

	/** Run a sync after delayMs. A pending full sync is never downgraded to a pull; an earlier time wins. */
	schedule(mode: Mode, delayMs: number) {
		const due = Date.now() + delayMs;
		if (this.timer !== null) {
			if (mode === "full") this.timerMode = "full";
			if (due >= this.timerDue) return;
			window.clearTimeout(this.timer);
		} else {
			this.timerMode = mode;
		}
		this.timerDue = due;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.run(this.timerMode);
		}, delayMs);
	}

	// ---- syncing --------------------------------------------------------

	async syncNow(mode: Mode) {
		if (!this.loggedIn()) return this.login();
		if (!this.settings.repo) return this.chooseRepo();
		await this.run(mode, true);
	}

	private async run(mode: Mode, manual = false): Promise<void> {
		if (!this.loggedIn() || !this.settings.repo) return;
		if (this.running) {
			if (this.rerun !== "full") this.rerun = mode;
			return;
		}
		this.running = true;
		this.setPhase("syncing", mode === "full" ? "Syncing…" : "Checking GitHub…");
		const dirtyAtStart = new Set(this.dirty);
		try {
			const result = await this.getEngine().sync(mode);
			if (mode === "full") for (const p of dirtyAtStart) this.dirty.delete(p);
			this.status.lastSync = new Date();
			this.status.lastResult = result;
			this.report(result, manual);
			this.setPhase("idle", "");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.addLog(`error: ${msg}`);
			// Whatever was pulled before the error is on disk; remember that.
			await this.save().catch(() => {});
			if (e instanceof AuthError) {
				this.loginExpired(msg);
			} else {
				this.setPhase("error", msg);
				if (manual) new Notice(`Git sync failed: ${msg}`);
			}
		} finally {
			this.running = false;
		}
		const next = this.rerun;
		this.rerun = null;
		if (next) await this.run(next);
	}

	private report(r: SyncResult, manual: boolean) {
		const parts: string[] = [];
		if (r.pulled.length) parts.push(`pulled ${r.pulled.length}`);
		if (r.merged.length) parts.push(`merged ${r.merged.length}`);
		if (r.pushed.length) parts.push(`pushed ${r.pushed.length}`);
		if (parts.length) this.addLog(`${parts.join(", ")}${r.commit ? ` (${r.commit.slice(0, 7)})` : ""}`);
		if (r.conflicts.length) {
			this.status.conflicts = [...new Set([...r.conflicts, ...this.status.conflicts])].slice(0, 50);
			this.addLog(`kept both versions: ${r.conflicts.join(", ")}`);
			new Notice(`Git sync kept both versions in:\n${r.conflicts.join("\n")}\nSee the sync panel.`, 10000);
		} else if (manual) {
			new Notice(parts.length ? `Git sync: ${parts.join(", ")}` : "Git sync: up to date");
		}
	}

	private getEngine(): SyncEngine {
		if (this.engine) return this.engine;
		const target = this.target();
		if (this.state.target !== target) {
			// Different repo or branch: the old snapshot means nothing here.
			this.state = emptyState(target);
		}
		const store = new VaultStore(
			this.app,
			() => ({
				includeConfigDir: this.settings.includeConfigDir,
				extraIgnore: this.settings.extraIgnore,
				pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			}),
			(path) => this.selfWrites.set(path, Date.now()),
		);
		const branch = this.branch();
		const device = this.settings.deviceName.replace(/[^A-Za-z0-9._-]+/g, "-") || "device";
		this.engine = new SyncEngine(store, new GitHub(this.auth, this.settings.repo), {
			branch,
			deviceName: device,
			deviceBranch: this.settings.useDeviceBranch ? `sync/${device}` : null,
			state: this.state,
			saveState: () => this.save(),
			forbidden: () => {
				const c = this.credentials();
				return c ? [c.access, c.refresh ?? ""] : [];
			},
			log: (m) => this.addLog(m),
		});
		return this.engine;
	}

	/** Settings that change what or where we sync call this. */
	resetEngine() {
		this.engine = null;
	}

	async pendingChanges(): Promise<Change[]> {
		if (!this.loggedIn() || !this.settings.repo) return [];
		return this.getEngine().pendingChanges();
	}

	branch() {
		return this.settings.branch || "main";
	}

	private target() {
		return `${this.settings.repo}@${this.branch()}`;
	}

	// ---- login ----------------------------------------------------------

	/** The login lives in Obsidian's secret storage (or app storage on older versions), never in the vault folder. */
	credentials(): Credentials | null {
		const secrets = (this.app as any).secretStorage;
		const raw: string | null = secrets ? secrets.getSecret(TOKEN_ID) : this.app.loadLocalStorage(TOKEN_ID);
		if (!raw) return null;
		try {
			const c = JSON.parse(raw);
			if (c && typeof c.access === "string") return c;
		} catch {
			/* a bare token from an earlier version */
		}
		return { access: raw };
	}

	private setCredentials(c: Credentials | null) {
		const raw = c ? JSON.stringify(c) : null;
		const secrets = (this.app as any).secretStorage;
		if (secrets) secrets.setSecret(TOKEN_ID, raw ?? "");
		this.app.saveLocalStorage(TOKEN_ID, secrets ? null : raw);
	}

	loggedIn(): boolean {
		return this.credentials() !== null;
	}

	/** The login can't be refreshed (unused for 6 months, or revoked): ask again. */
	private loginExpired(reason: string) {
		this.setCredentials(null);
		this.setPhase("logged-out", reason);
		new Notice("Git sync: your GitHub login expired. Please log in again.", 10000);
		this.login();
	}

	clientId() {
		return this.settings.clientId.trim();
	}

	login() {
		if (this.loginOpen) return;
		this.loginOpen = true;
		this.lastLoginPrompt = Date.now();
		new LoginModal(this.app, this, async (credentials) => {
			this.setCredentials(credentials);
			this.settings.username = await new GitHub(this.auth, "").user().catch(() => "");
			await this.save();
			new Notice(`Logged in to GitHub${this.settings.username ? ` as ${this.settings.username}` : ""}`);
			if (!this.settings.repo) this.chooseRepo();
			else this.schedule("full", 0);
		}, () => (this.loginOpen = false)).open();
		this.refresh();
	}

	async logout() {
		this.setCredentials(null);
		this.settings.username = "";
		await this.save();
		this.setPhase("logged-out", "");
	}

	async chooseRepo() {
		if (!this.loggedIn()) return this.login();
		try {
			const { repos, appSlug } = await new GitHub(this.auth, "").listRepos();
			if (appSlug && appSlug !== this.settings.appSlug) {
				this.settings.appSlug = appSlug;
				await this.save();
			}
			const installUrl = this.settings.appSlug
				? `https://github.com/apps/${this.settings.appSlug}/installations/new`
				: "https://github.com/settings/apps";
			const openInstall = () => {
				// Pick up where we left off once the user comes back from GitHub.
				this.repoPickAfterInstall = true;
				window.open(installUrl);
			};
			// A brand-new app can't see any repositories: go straight to granting access.
			if (repos.length === 0) new InstallModal(this.app, openInstall).open();
			else new RepoPicker(this.app, repos, (repo) => this.setRepo(repo.fullName, repo.defaultBranch), openInstall).open();
		} catch (e) {
			if (e instanceof AuthError) return this.loginExpired(e.message);
			new Notice(`Could not list repositories: ${e instanceof Error ? e.message : e}`);
		}
	}

	async setRepo(repo: string, branch: string) {
		this.settings.repo = repo;
		this.settings.branch = branch;
		this.resetEngine();
		await this.save();
		this.refresh();
		this.schedule("full", 0);
	}

	// ---- status ---------------------------------------------------------

	private setPhase(phase: Phase, message: string) {
		this.status.phase = phase;
		this.status.message = message;
		this.refresh();
	}

	private addLog(text: string) {
		this.status.log.unshift({ at: new Date(), text });
		this.status.log.length = Math.min(this.status.log.length, 40);
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	refresh() {
		if (!this.loggedIn()) this.status.phase = "logged-out";
		else if (!this.settings.repo) this.status.phase = "no-repo";
		else if (this.status.phase === "logged-out" || this.status.phase === "no-repo") this.status.phase = "idle";
		if (this.statusBar) this.statusBar.setText(statusLine(this));
		this.listeners.forEach((cb) => cb());
	}

	dirtyCount() {
		return this.dirty.size;
	}

	async openPanel() {
		const existing = this.app.workspace.getLeavesOfType(PANEL_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: PANEL_VIEW, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async save() {
		await this.saveData({ settings: this.settings, state: this.state });
	}
}

export function ago(d: Date | null): string {
	if (!d) return "never";
	const s = Math.round((Date.now() - d.getTime()) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function statusLine(p: SimpleGitSync): string {
	switch (p.status.phase) {
		case "logged-out": return "Git: not logged in";
		case "no-repo": return "Git: choose a repository";
		case "syncing": return "Git: syncing…";
		case "error": return "Git: sync error";
		default: return `Git: synced ${ago(p.status.lastSync)}${p.dirtyCount() ? ` · ${p.dirtyCount()} unpushed` : ""}`;
	}
}
