# Simple Git Sync

An Obsidian plugin that keeps a vault in sync with a GitHub repository, on Android, iOS, macOS, Windows and Linux.

- **Nothing to install.** It doesn't use the `git` program. It talks to GitHub's web API directly, so it works the same on a phone as on a laptop.
- **Log in with a button.** On first launch it shows a short code; you approve it on github.com. No tokens to create or paste.
- **Syncs on its own.** Edit a note on your phone, switch to another note or put the phone away, and the change is on GitHub within seconds. Open your laptop and it's there.
- **Never throws work away.** If two devices change the same file, both versions are kept.
- **Leaves code repos alone.** Any folder inside the vault that is its own git repository is skipped entirely: not uploaded, not tracked, not a submodule.
- **Plays well with others.** Agents, scripts or you on the command line can commit straight to `main`; the plugin merges whatever it finds there.

## How it works

Each device remembers the last version of the vault it agreed on with GitHub (the "base"). On every sync it compares three things: the base, the files on the device, and the latest `main` on GitHub.

- Changed only on GitHub → downloaded.
- Changed only on this device → uploaded.
- Changed on both → merged like `git merge` does: edits to different parts of a note combine cleanly. If both sides changed the same lines, both versions are kept in the note between markers:

  ```
  <<<<<<< android-x7k2 (this device)
  what the phone wrote
  =======
  what was on GitHub
  >>>>>>> main on GitHub
  ```

  Files that can't be merged line-by-line (images, PDFs, …) keep this device's copy and save GitHub's copy beside it as `name (conflict 2026-10-26 1430).ext`.
- Deleted on one side but edited on the other → the edited version is kept.

Local changes become one commit on top of the latest `main`, whose message lists the files changed (`android-x7k2: Groceries.md, Trip.md`). The commit is first written to the device's own branch, `sync/<device>`, then `main` is moved forward to it. If someone else updated `main` in that instant, the plugin re-merges and tries again.

Deleted files go to Obsidian's trash, and everything ever synced stays in the repository's history.

### When it syncs

| Event | What happens |
| --- | --- |
| Obsidian starts | full sync |
| You leave a note you edited (switch notes, close the tab) | push about 2 s later |
| App goes to the background (phone) or you switch to another app (desktop) | push within a few seconds if anything changed |
| You keep editing the same note | push at most 2 min after an edit (configurable) |
| Every minute while Obsidian is open and visible | check GitHub for new changes (one small request when nothing changed) |
| "Sync now" in the panel or command palette | full sync |

Commits only happen on those events, not on every keystroke, so `main` gets a handful of meaningful commits rather than hundreds of tiny ones.

### What is never synced

- Folders that contain a `.git` (nested repositories), and everything under them
- `.git`, `.trash`, `.DS_Store`
- The `.obsidian` settings folder, unless you turn it on in settings. Even then, this plugin's own folder and the window layout files (`workspace*.json`) are always skipped.
- Anything matched by a `.gitignore` at the root of the vault, or by the "Also ignore" setting

Ignored files that already exist on GitHub are left untouched there.

## The control panel

Click the ↻ icon in the left ribbon (or run **Simple Git Sync: Open sync panel**). It shows:

- status and the last sync time, plus the GitHub commit you're at
- **Sync now**
- files changed on this device that aren't on GitHub yet
- files where both versions were kept, with links to open them
- a short activity log

On desktop the status bar also shows `Git: synced 2 min ago`.

## Setup

Start from a plain, empty folder as the vault. Don't clone the repository yourself; the plugin downloads it.

1. Install the plugin. Until it's in Obsidian's community list, use [BRAT](https://github.com/TfTHacker/obsidian42-brat): install BRAT from Community plugins, then **BRAT → Add beta plugin →** `michaelenew/obsidian-git-plugin`.
2. Enable **Simple Git Sync**. The plugin walks you through the rest:
   - **First device only: create your sync app.** Logging in goes through a small GitHub App that belongs to you, so no third party's app ever has access to your notes. The plugin opens GitHub's "new app" page with everything filled in (private, no webhook, access to file contents only). Tick **Enable Device Flow**, click **Create GitHub App**, and paste the **Client ID** from the next page back into the plugin. On later devices, the plugin links to your list of GitHub apps so you can copy the same Client ID.
   - **Log in:** tap **Copy code and open GitHub**, paste the code, approve.
   - **Give the app access to your vault.** The first time, the app can't see any repositories, so the plugin offers to open GitHub's install page: choose *Only select repositories*, pick your vault repository, click Install, and come back to Obsidian. (Later you can add repositories from the bottom of the repository list.)
   - **Pick the repository** from the list that opens.
3. The first sync downloads everything.

The Client ID is stored in the plugin's settings on each device. It is not a secret, but it is yours: it never goes into the plugin's code or into the vault.

For a new device, start from an empty vault. If the vault already has files, they're merged with GitHub's: files that exist on both sides with different contents are kept as two files.

## Security

- The login token is stored with Obsidian's secret storage (`app.secretStorage`; on Obsidian older than 1.11.4, the app's local storage). It is never written to any file in the vault, including the plugin's own `data.json`.
- The plugin's folder is always excluded from syncing, whatever the settings.
- Logins expire on their own: GitHub App tokens last 8 hours and the plugin quietly swaps them for fresh ones using a refresh token (valid 6 months, and renewed each time). If the login can't be renewed (unused for 6 months, or you revoked it on GitHub), the plugin asks you to log in again; if you dismiss that, it asks again next time you return to Obsidian, at most every 30 minutes. Being offline never logs you out.
- Before uploading, every file is checked for the login tokens; if it's found, the sync stops with an error instead of uploading.
- The token is only sent to `api.github.com` and `github.com`.
- A sync that would delete more than half the files on GitHub (and more than 20) is refused, in case a device ever misreads its own folder as empty.

## Limits

- Phones may pause Obsidian a few seconds after it goes to the background. A push that didn't finish is completed next time Obsidian is opened.
- GitHub allows 5,000 API requests per hour. Normal use needs a small fraction of that, but the first sync of a large vault uses one request per file.
- Repositories with more than about 100,000 files are not supported.
- File modes other than normal and executable files (symlinks, submodules) on GitHub are ignored.

## Development

```sh
npm install
npm test        # sync scenarios against an in-memory GitHub
npm run build   # main.js
npm run dev     # rebuild on change
```

Releases are automatic: every merge to `main` builds the plugin and publishes a GitHub release (version `major.minor` from `manifest.json` plus a build number), which BRAT installs as an update. Change `major.minor` in `manifest.json` only when you want to.

Code map: `src/engine.ts` decides what to download, merge and upload; `src/github.ts` is the GitHub API and login; `src/vaultStore.ts` reads and writes the vault and applies the skip rules; `src/main.ts` wires up the triggers; `src/ui.ts` is the panel, login window and settings.
