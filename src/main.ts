import { Notice, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import { Change, emptyState, Mode, SyncEngine, SyncFailure, SyncResult, SyncState } from "./engine";
import { Auth, AuthError, Credentials, isOffline, NetworkError } from "./auth";
import { GitHub } from "./github";
import { unannounced } from "./notify";
import { InstallModal, LoginModal, PANEL_VIEW, RepoPicker, SettingsTab, SyncPanel } from "./ui";
import { VaultStore } from "./vaultStore";

/** Used by versions up to 0.1.5, shared by every vault on the device. */
const LEGACY_TOKEN_ID = "simple-git-sync-github-token";

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
	/** Moved the login from the shared pre-0.1.6 storage entry to this vault's own */
	tokenMigrated: boolean;
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
	tokenMigrated: false,
};

export type Phase = "logged-out" | "no-repo" | "idle" | "syncing" | "offline" | "error";

export interface Status {
	phase: Phase;
	message: string;
	lastSync: Date | null;
	lastResult: SyncResult | null;
	conflicts: string[];
	/** Files the last full sync couldn't upload, with GitHub's answer */
	failed: SyncFailure[];
	log: Array<{ at: Date; text: string }>;
}

export default class SimpleGitSync extends Plugin {
	settings!: Settings;
	private state!: SyncState;
	status: Status = { phase: "logged-out", message: "", lastSync: null, lastResult: null, conflicts: [], failed: [], log: [] };

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
	readonly auth = new Auth(
		() => this.credentials(),
		(c) => this.setCredentials(c),
		() => this.clientId(),
		(c) => this.addLog(`GitHub login renewed${c.expiresAt ? `; valid until ${new Date(c.expiresAt).toLocaleString()}` : ""}`),
	);
	statusBar: HTMLElement | null = null;

	async onload() {
		const data = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULTS, deviceName: defaultDeviceName(), ...data.settings };
		this.state = data.state ?? emptyState(this.target());
		this.notified = new Set(data.notified ?? []);
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
		// A sync in flight can't be cancelled, so make sure it can't do anything more.
		this.active = false;
		this.auth.stop();
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

		// Back online: push whatever was edited meanwhile and pull what others did.
		this.registerDomEvent(window, "online", () => this.schedule("full", 1000));
		this.registerDomEvent(window, "offline", () => {
			if (this.status.phase === "idle" || this.status.phase === "error") this.setPhase("offline", "");
		});

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
		if (this.running) {
			new Notice(`Git sync is already running${this.status.message ? ` (${this.status.message})` : ""}. It will sync again when it finishes.`);
		}
		await this.run(mode, true);
	}

	private async run(mode: Mode, manual = false): Promise<void> {
		if (!this.active || !this.loggedIn() || !this.settings.repo) return;
		if (isOffline()) {
			// Nothing to try; the "online" event starts a sync when the connection returns.
			this.setPhase("offline", "");
			if (manual) new Notice("You're offline. Changes will sync when you're back online.");
			return;
		}
		if (this.running) {
			if (this.rerun !== "full") this.rerun = mode;
			return;
		}
		this.running = true;
		this.setPhase("syncing", mode === "full" ? "syncing…" : "checking GitHub…");
		const dirtyAtStart = new Set(this.dirty);
		const loginAtStart = this.credentials();
		try {
			const result = await this.getEngine().sync(mode);
			if (mode === "full") for (const p of dirtyAtStart) this.dirty.delete(p);
			this.status.lastSync = new Date();
			this.status.lastResult = result;
			this.report(result, manual);
			this.lastErrorShown = "";
			this.retriedNewLogin = false;
			this.setPhase("idle", "");
		} catch (e) {
			if (!this.active) return;
			const msg = e instanceof Error ? e.message : String(e);
			this.addLog(`error: ${msg}`);
			// Whatever was pulled before the error is on disk; remember that.
			await this.save().catch(() => {});
			const loginNow = this.credentials();
			if (e instanceof AuthError && loginNow && loginNow.refresh !== loginAtStart?.refresh && !this.retriedNewLogin) {
				this.retriedNewLogin = true;
				// Another copy of the plugin renewed the login during this sync; the new one is fine.
				this.addLog("the login was renewed during this sync; retrying with the new one");
				this.setPhase("idle", "");
				this.schedule("full", 5000);
			} else if (e instanceof AuthError) {
				this.loginExpired(msg);
			} else if (e instanceof NetworkError) {
				// Offline or no signal: not an error. The next trigger or the "online" event retries.
				this.setPhase("offline", msg);
				if (manual) new Notice(`Can't reach GitHub right now (${msg}). Changes will sync when the connection is back.`);
			} else {
				this.setPhase("error", msg);
				// Show each new problem once, even for background syncs.
				// Compare without GitHub's request id, which differs on every attempt.
				const same = msg.replace(/\s*\[request [^\]]*\]/g, "");
				if (manual || same !== this.lastErrorShown) new Notice(`Git sync failed: ${msg}`, 15000);
				this.lastErrorShown = same;
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
		// A pull that found nothing new checked no files, so the known failures still stand.
		if (!r.unchanged) {
			// Uploads are only tried in full syncs, so a pull keeps the last full sync's upload failures.
			const ups = (r.mode === "full" ? r.failed : this.status.failed).filter((f) => f.direction === "up");
			this.status.failed = [...ups, ...r.failed.filter((f) => f.direction === "down")];
			this.notifyFailures(this.status.failed);
		}
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
		const github = new GitHub(this.auth, this.settings.repo, (notice) => {
			// Full detail in the activity log; a short version in the status line.
			this.addLog(notice);
			const wait = /waiting (\d+) s/.exec(notice);
			this.progress(wait ? `GitHub asked to wait ${wait[1]} s` : "GitHub hiccup, retrying");
		});
		this.engine = new SyncEngine(store, github, {
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
			progress: (m) => this.progress(m),
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
		let raw: string | null = secrets ? secrets.getSecret(this.tokenId()) : this.app.loadLocalStorage(this.tokenId());
		if (!raw && !this.settings.tokenMigrated) {
			// One-time move from the shared entry. It's left in place in case another vault still uses it.
			raw = secrets ? secrets.getSecret(LEGACY_TOKEN_ID) : this.app.loadLocalStorage(LEGACY_TOKEN_ID);
			this.settings.tokenMigrated = true;
			void this.save();
			if (raw) this.writeSecret(raw);
		}
		if (!raw) {
			if (this.expectLogin) {
				this.expectLogin = false;
				this.addLog("the saved GitHub login disappeared from Obsidian's secret storage, without this copy of the plugin removing it");
			}
			return null;
		}
		this.expectLogin = true;
		try {
			const c = JSON.parse(raw);
			if (c && typeof c.access === "string") return c;
		} catch {
			/* a bare token from an earlier version */
		}
		return { access: raw };
	}

	private setCredentials(c: Credentials | null) {
		this.writeSecret(c ? JSON.stringify(c) : null);
	}

	private writeSecret(raw: string | null) {
		if (!this.active) return;
		this.expectLogin = raw !== null;
		const secrets = (this.app as any).secretStorage;
		if (secrets) secrets.setSecret(this.tokenId(), raw ?? "");
		this.app.saveLocalStorage(this.tokenId(), secrets ? null : raw);
	}

	/**
	 * Obsidian's secret storage is shared by all vaults on the device, so each vault
	 * keeps its login under its own name; another vault can't overwrite or clear it.
	 */
	private tokenId(): string {
		const vault = String((this.app as any).appId ?? this.app.vault.getName());
		return `simple-git-sync-${vault.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
	}

	loggedIn(): boolean {
		return this.credentials() !== null;
	}

	/** The login can't be refreshed (unused for 6 months, or revoked): ask again. */
	private loginExpired(reason: string) {
		if (!this.active) return;
		this.setCredentials(null);
		this.setPhase("logged-out", reason);
		// Stays until dismissed, with GitHub's reason, so the cause can be reported.
		new Notice(`Git sync: please log in to GitHub again.\n\nReason: ${reason}`, 0);
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

	private lastProgress = 0;
	private lastErrorShown = "";
	/** Retried once after the login changed mid-sync; a second refusal is a real logout. */
	private retriedNewLogin = false;
	/** False once unloaded; an old copy's leftover work must not touch the login or saved state. */
	private active = true;
	/** Whether the login should be in storage, to notice if it vanishes without us removing it. */
	private expectLogin = false;
	/** Files already announced as failing ("up:path" / "down:path"), kept across restarts. */
	private notified = new Set<string>();

	/** One notice per failing file, until it syncs again; see unannounced(). */
	private notifyFailures(failed: SyncFailure[]) {
		const { fresh, notified } = unannounced(this.notified, failed);
		const changed = notified.size !== this.notified.size || [...notified].some((k) => !this.notified.has(k));
		this.notified = notified;
		if (changed) void this.save();
		if (!fresh.length) return;
		const older = failed.length - fresh.length;
		new Notice(
			`Git sync: ${fresh.length === 1 ? "1 file" : `${fresh.length} files`} couldn't be synced. Everything else synced, and nothing was lost.\n\n` +
				fresh.map((f) => `• ${f.error}`).join("\n\n") +
				(older ? `\n\n(${older} more, already reported, are listed in the sync panel.)` : ""),
			0,
		);
	}

	/** Show what a long sync is doing, without redrawing the panel on every file. */
	private progress(message: string) {
		if (this.status.phase !== "syncing") return;
		this.status.message = message;
		if (Date.now() - this.lastProgress < 500) return;
		this.lastProgress = Date.now();
		this.refresh();
	}

	private addLog(text: string) {
		// Repeats (e.g. the same error every minute) update the time instead of filling the log.
		if (this.status.log[0]?.text === text) {
			this.status.log[0].at = new Date();
			return;
		}
		this.status.log.unshift({ at: new Date(), text });
		this.status.log.length = Math.min(this.status.log.length, 200);
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
		// An unloaded copy's state is out of date; the new copy owns data.json now.
		if (!this.active) return;
		await this.saveData({ settings: this.settings, state: this.state, notified: [...this.notified] });
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
		case "syncing": return `Git: ${p.status.message || "syncing…"}`;
		case "offline": return `Git: offline${p.dirtyCount() ? ` · ${p.dirtyCount()} unpushed` : ""}`;
		case "error": return "Git: sync error";
		default: return `Git: synced ${ago(p.status.lastSync)}${p.dirtyCount() ? ` · ${p.dirtyCount()} unpushed` : ""}${p.status.failed.length ? ` · ${p.status.failed.length} not synced` : ""}`;
	}
}
