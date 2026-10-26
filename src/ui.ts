import { App, ItemView, Modal, Notice, PluginSettingTab, Setting, SuggestModal, WorkspaceLeaf } from "obsidian";
import type { Change } from "./engine";
import type { Credentials } from "./auth";
import { RepoInfo, startDeviceLogin, waitForDeviceLogin } from "./github";
import type SimpleGitSync from "./main";
import { ago, statusLine } from "./main";

export const PANEL_VIEW = "simple-git-sync-panel";

export class LoginModal extends Modal {
	private cancelled = false;

	constructor(
		app: App,
		private plugin: SimpleGitSync,
		private onLogin: (credentials: Credentials) => Promise<void>,
		private onDone: () => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("Log in to GitHub");
		void this.start();
	}

	private async start() {
		const el = this.contentEl;
		el.empty();
		const clientId = this.plugin.clientId();
		if (!clientId) {
			el.createEl("p", { text: "This build of the plugin has no GitHub App client ID yet. Set one under Settings → Simple Git Sync → Advanced (see the plugin README)." });
			return;
		}
		el.createEl("p", { text: "Asking GitHub for a login code…" });
		try {
			const code = await startDeviceLogin(clientId);
			el.empty();
			el.createEl("p", { text: "1. Copy this code:" });
			el.createEl("div", { text: code.userCode, cls: "sgs-code" });
			el.createEl("p", { text: "2. Paste it on GitHub and approve. This window closes by itself when you're done." });
			new Setting(el).addButton((b) =>
				b.setButtonText("Copy code and open GitHub").setCta().onClick(async () => {
					await navigator.clipboard.writeText(code.userCode).catch(() => {});
					window.open(code.verificationUri);
				}),
			);
			const waiting = el.createEl("p", { text: "Waiting for approval…", cls: "sgs-muted" });
			const credentials = await waitForDeviceLogin(clientId, code, () => this.cancelled);
			waiting.setText("Logged in.");
			await this.onLogin(credentials);
			this.close();
		} catch (e) {
			if (this.cancelled) return;
			el.empty();
			el.createEl("p", { text: `Login failed: ${e instanceof Error ? e.message : e}` });
			new Setting(el).addButton((b) => b.setButtonText("Try again").onClick(() => this.start()));
		}
	}

	onClose() {
		this.cancelled = true;
		this.onDone();
	}
}

export class RepoPicker extends SuggestModal<RepoInfo> {
	constructor(
		app: App,
		private repos: RepoInfo[],
		private onPick: (r: RepoInfo) => void,
	) {
		super(app);
		this.setPlaceholder("Which repository holds this vault?");
	}

	getSuggestions(query: string): RepoInfo[] {
		const q = query.toLowerCase();
		return this.repos.filter((r) => r.fullName.toLowerCase().includes(q));
	}

	renderSuggestion(r: RepoInfo, el: HTMLElement) {
		el.createEl("div", { text: r.fullName });
		el.createEl("small", { text: `${r.private ? "private" : "public"} · ${r.defaultBranch}`, cls: "sgs-muted" });
	}

	onChooseSuggestion(r: RepoInfo) {
		this.onPick(r);
	}
}

export class SyncPanel extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private pending: Change[] = [];
	private tick: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: SimpleGitSync,
	) {
		super(leaf);
	}

	getViewType() {
		return PANEL_VIEW;
	}

	getDisplayText() {
		return "Git sync";
	}

	getIcon() {
		return "refresh-cw";
	}

	async onOpen() {
		this.unsubscribe = this.plugin.onChange(() => this.render());
		this.tick = window.setInterval(() => this.render(), 30_000);
		await this.reloadPending();
	}

	async onClose() {
		this.unsubscribe?.();
		if (this.tick !== null) window.clearInterval(this.tick);
	}

	private async reloadPending() {
		try {
			this.pending = await this.plugin.pendingChanges();
		} catch {
			this.pending = [];
		}
		this.render();
	}

	private render() {
		const { status, settings } = this.plugin;
		const el = this.contentEl;
		el.empty();
		el.addClass("sgs-panel");

		el.createEl("div", { text: statusLine(this.plugin), cls: `sgs-status sgs-${status.phase}` });
		if (status.phase === "error") el.createEl("div", { text: status.message, cls: "sgs-error" });

		const buttons = el.createDiv("sgs-buttons");
		if (status.phase === "logged-out") {
			button(buttons, "Log in to GitHub", () => this.plugin.login(), true);
		} else if (status.phase === "no-repo") {
			button(buttons, "Choose repository", () => this.plugin.chooseRepo(), true);
		} else {
			button(buttons, "Sync now", async () => {
				await this.plugin.syncNow("full");
				await this.reloadPending();
			}, true);
			button(buttons, "Refresh", () => this.reloadPending());
		}

		if (settings.repo) {
			const info = el.createDiv("sgs-info");
			const link = info.createEl("a", { text: `${settings.repo} @ ${this.plugin.branch()}`, href: `https://github.com/${settings.repo}` });
			link.setAttr("target", "_blank");
			info.createDiv({ text: `This device: ${settings.deviceName}${settings.username ? ` (${settings.username})` : ""}` });
			const r = status.lastResult;
			info.createDiv({ text: `Last sync: ${ago(status.lastSync)}${r ? ` · GitHub at ${(r.commit ?? r.head).slice(0, 7)}` : ""}` });
		}

		section(el, `Not yet pushed (${this.pending.length})`, this.pending.map((c) => ({ path: c.path, note: c.kind })), this.app);
		section(el, "Kept both versions (check these)", status.conflicts.map((path) => ({ path, note: "" })), this.app, () => {
			status.conflicts = [];
			this.render();
		});

		el.createEl("h6", { text: "Activity" });
		const log = el.createDiv("sgs-log");
		if (!status.log.length) log.createDiv({ text: "Nothing yet", cls: "sgs-muted" });
		for (const entry of status.log) {
			const row = log.createDiv();
			row.createSpan({ text: entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " ", cls: "sgs-muted" });
			row.createSpan({ text: entry.text });
		}
	}
}

function button(parent: HTMLElement, text: string, onClick: () => unknown, cta = false) {
	const b = parent.createEl("button", { text });
	if (cta) b.addClass("mod-cta");
	b.onclick = () => void onClick();
}

function section(el: HTMLElement, title: string, rows: Array<{ path: string; note: string }>, app: App, onClear?: () => void) {
	if (!rows.length) return;
	const head = el.createDiv("sgs-section-head");
	head.createEl("h6", { text: title });
	if (onClear) button(head, "Clear", onClear);
	const list = el.createDiv("sgs-list");
	for (const r of rows.slice(0, 100)) {
		const row = list.createDiv("sgs-row");
		const a = row.createEl("a", { text: r.path });
		a.onclick = () => void app.workspace.openLinkText(r.path, "", false);
		if (r.note) row.createSpan({ text: ` ${r.note}`, cls: "sgs-muted" });
	}
}

export class SettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SimpleGitSync,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl: el, plugin } = this;
		const s = plugin.settings;
		const save = async () => {
			await plugin.save();
			plugin.refresh();
		};
		el.empty();

		new Setting(el)
			.setName("GitHub account")
			.setDesc(plugin.loggedIn() ? `Logged in${s.username ? ` as ${s.username}` : ""}. The login is kept in Obsidian's secure storage on this device, never in the vault.` : "Not logged in.")
			.addButton((b) =>
				plugin.loggedIn()
					? b.setButtonText("Log out").onClick(async () => {
						await plugin.logout();
						this.display();
					})
					: b.setButtonText("Log in").setCta().onClick(() => plugin.login()),
			);

		new Setting(el)
			.setName("Repository")
			.setDesc(s.repo ? `${s.repo}, branch ${plugin.branch()}` : "None chosen")
			.addButton((b) => b.setButtonText("Choose…").onClick(() => plugin.chooseRepo()));

		new Setting(el)
			.setName("Device name")
			.setDesc("Shown in commit messages. Each device also keeps a copy of its latest commit on the branch sync/<device name>.")
			.addText((t) =>
				t.setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim();
					plugin.resetEngine();
					await save();
				}),
			);

		new Setting(el).setHeading().setName("When to sync");

		new Setting(el)
			.setName("Push when leaving a note")
			.setDesc("After you edit a note and switch to another one (or close it), push within a couple of seconds. Changes are also pushed when the app goes to the background.")
			.addToggle((t) =>
				t.setValue(s.syncOnFileSwitch).onChange(async (v) => {
					s.syncOnFileSwitch = v;
					await save();
				}),
			);

		new Setting(el)
			.setName("Push edits after (seconds)")
			.setDesc("Fallback for when you stay in one note: unpushed edits go up at most this long after you make them.")
			.addText((t) =>
				t.setValue(String(s.idlePushSec)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n >= 10) {
						s.idlePushSec = n;
						await save();
					}
				}),
			);

		new Setting(el)
			.setName("Check GitHub every (seconds)")
			.setDesc("How often to pull others' changes while Obsidian is open. Each check is one small request.")
			.addText((t) =>
				t.setValue(String(s.pullIntervalSec)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n >= 15) {
						s.pullIntervalSec = n;
						plugin.restartPullTimer();
						await save();
					}
				}),
			);

		new Setting(el).setHeading().setName("What to sync");

		new Setting(el)
			.setName(`Sync the ${this.app.vault.configDir} folder`)
			.setDesc("Obsidian's own settings, themes and plugins. Off by default because phone and desktop often want different settings, and some plugins keep secrets there. This plugin's own folder and the window layout are never synced.")
			.addToggle((t) =>
				t.setValue(s.includeConfigDir).onChange(async (v) => {
					s.includeConfigDir = v;
					plugin.resetEngine();
					await save();
				}),
			);

		new Setting(el)
			.setName("Also ignore")
			.setDesc("Extra patterns to skip, one per line, same format as .gitignore. Git repositories inside the vault are always skipped.")
			.addTextArea((t) =>
				t.setValue(s.extraIgnore).setPlaceholder("Archive/\n*.tmp").onChange(async (v) => {
					s.extraIgnore = v;
					plugin.resetEngine();
					await save();
				}),
			);

		new Setting(el).setHeading().setName("Advanced");

		new Setting(el)
			.setName("Keep per-device branches")
			.setDesc("Write each commit to sync/<device> before main, so a push that couldn't reach main is still on GitHub.")
			.addToggle((t) =>
				t.setValue(s.useDeviceBranch).onChange(async (v) => {
					s.useDeviceBranch = v;
					plugin.resetEngine();
					await save();
				}),
			);

		new Setting(el)
			.setName("Branch")
			.setDesc("Usually the repository's main branch.")
			.addText((t) =>
				t.setValue(s.branch).setPlaceholder("main").onChange(async (v) => {
					s.branch = v.trim();
					plugin.resetEngine();
					await save();
				}),
			);

		new Setting(el)
			.setName("GitHub App client ID")
			.setDesc("Only needed if this build doesn't include one. Public, not a secret.")
			.addText((t) =>
				t.setValue(s.clientId).onChange(async (v) => {
					s.clientId = v.trim();
					await save();
				}),
			);

		new Setting(el).addButton((b) =>
			b.setButtonText("Open sync panel").onClick(() => {
				void plugin.openPanel();
				new Notice("Sync panel opened in the right sidebar");
			}),
		);
	}
}
