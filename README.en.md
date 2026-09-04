# dsh-quick-window-launcher

Launch DeepSeek Harness web **in its own standalone app-style window** — from a desktop shortcut — instead of jumping to a default-browser tab — plus shutdown / restart power controls and an `open_web` tool.

On boot the plugin:

- **Generates a desktop shortcut** (`DeepSeek Harness.lnk`) that starts the harness if it isn't running, then opens it in a **dedicated app-mode window** (Chromium & Edge `--app=<url>`), not a tab. Falls back to the system default browser only when no Chromium-based browser is installed.
- **Adds a shutdown button** (⏻) at the sidebar foot — gracefully stops the harness (SIGTERM → dispose → flush persistence → exit).
- **Adds a restart button** (⟳) — gracefully stops the process, then relaunches a fresh instance via a persistent watchdog.
- **Adds a segmented power-control bar** at the sidebar foot: three icon-only segments in a glass pill (shutdown / restart / DSH update check), each with a hover glow and tooltip; when the sidebar is collapsed it degrades to a standalone circular red power key.
- **Adds a DSH update-check button** (⬇) — queries npm for the latest `@deepseek-ai/dsh` version and reports the **current version** and whether it is **up to date**; when a newer version exists it can **one-click open a visible terminal to run the update** (npm output and elevation prompts stay visible; the command is also copied to the clipboard), then click Restart to apply.
- **Registers an `open_web` model tool** — opens a URL in the system default browser's **new tab**.

Everything is derived from the live harness at runtime — the Node binary, the dsh entry script, the working directory, the listening port, and `~/.dsh/logs`.

---

## Install

The plugin targets the `web` profile. Add it with the `dsh` plugin command:

```powershell
dsh plugin --profile web add Yuanloss/dsh-quick-window-launcher
```

Then (re)start the harness:

```powershell
dsh web
```

On the first boot the plugin writes two **pure-Node helper scripts** (`.cjs`) into `%USERPROFILE%\.dsh\logs`, starts the persistent restart watchdog (a node process too), and creates/refreshes the `DeepSeek Harness.lnk` desktop shortcut (which targets `node.exe` directly). **No `.ps1` file is ever written and no PowerShell runtime is involved** — antivirus products such as Huorong quarantine any newly created PowerShell script on sight (observed live; this version rewrote the whole host side for that reason).

> A restart is required for a new bundle to load. The desktop shortcut and the sidebar buttons appear once the plugin is active.

## What the desktop shortcut does

Double-click **`DeepSeek Harness`** on your desktop (its target is simply `node.exe dsh-launch-web.cjs`). The launcher:

1. Checks whether the harness is already listening on its port.
2. **Multi-signal liveness check**: when the port is closed it also checks the task-board ledger lock (`~/.dsh/task-board/ledger-v2.lock`) — if its owner PID is still alive, the previous instance is half-alive, so the launcher does **NOT** spawn a second instance (it would die inside another plugin's single-instance guard); instead it writes a diagnostic page and `dsh-launcher.log` and exits.
3. If it really is not running, starts it (hidden) with the same Node binary / entry the plugin itself runs under.
4. Waits until the UI is reachable (if the spawned instance exits early, an error page is shown instead of opening a window pointed at a dead port).
5. **Opens it in a standalone app-mode window** — it finds Google Chrome or Microsoft Edge and launches it with `--app=<url>`, so the interface opens in its own borderless window. If no Chromium-based browser is installed it falls back to your default browser. **Before opening, the launcher fetches this process's authenticated URL (with the launch token) from the harness and lets it mint the auth cookie in the isolated window profile** — the app window is logged in just like your normal browser, so the "authentication required; reopen the URL printed by dsh web" screen never appears.

Every launcher decision (port/lock check, spawn, readiness, window) is written to `~/.dsh/logs/dsh-launcher.log`. For troubleshooting run:

```powershell
node "$env:USERPROFILE\.dsh\logs\dsh-launch-web.cjs" --diagnose
```

It prints port status, task-board lock owner, watchdog heartbeat and recent log lines.

## Manual desktop shortcut (fallback)

Normally the plugin refreshes `DeepSeek Harness.lnk` automatically on every boot. In rare cases it may be missing (e.g. a OneDrive-redirected desktop that took long to mount); recreate it with one command:

```powershell
$l = "$env:USERPROFILE\.dsh\logs\dsh-launch-web.cjs"
$d = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'DeepSeek Harness.lnk'))
$s.TargetPath = (Get-Command node).Source
$s.Arguments = "`"$l`""
$s.WorkingDirectory = Split-Path $l -Parent
$s.Save()
```

> The plugin's automatic refreshes are logged to `%USERPROFILE%\.dsh\logs\dsh-shortcut.log` — check it if the shortcut fails to appear.

## Features

### Shutdown
A red power icon beside the sidebar foot. Asking for confirmation stops the harness gracefully — session data is flushed and the page is closed (or rewritten to a "closed" note if the browser blocks `window.close()`).

### Restart
A blue restart icon that gracefully stops the process and then relaunches a fresh instance. Restart is done by a **watchdog running outside the harness process tree** (the harness cleans up its own child processes, so a click-time spawn would die). The page shows a "restarting…" screen that polls until the fresh instance answers, then reloads.

The watchdog **self-heals with a heartbeat and a released lock**: after each restart it immediately listens again, and any transient error releases the lock and leaves a trace — it can never go deaf and ignore later requests after its first restart (a v0.2.4 bug fixed in v0.2.5).

### `open_web` tool
The model can call `open_web` with an `https://…`/`http://…` URL to open it in the system default browser's new tab — matching the harness convention of opening web pages externally rather than framing them.

## Settings

The row accepts optional config (set it via a profile patch override):

| key | default | meaning |
| --- | --- | --- |
| `createShortcut` | `true` | generate/refresh the desktop shortcut to point at this plugin's app-window launcher (set `false` to opt out) |
| `desktopName` | `DeepSeek Harness` | base file name of the shortcut |
| `desktopPath` | (auto) | **explicitly set the desktop directory** (OneDrive-redirected / network desktops where auto-detection fails). Resolution order: `desktopPath` → Windows registry `User Shell Folders\Desktop` (read from Node) → `~/Desktop` |
| `watchdog` | `true` | write and launch the restart watchdog at boot (`/api/restart` depends on it; with `false` the restart button degrades to shutdown-only) |

Example:

```yaml
- id: quick-window-launcher
  name: 'dsh-quick-window-launcher'
  config:
    createShortcut: true
    desktopName: 'DeepSeek Harness'
    watchdog: true
```

## Security

The HTTP routes (`/api/shutdown`, `/api/restart`) accept only loopback clients and reject cross-origin requests; they are POST-only. `open_web` only opens `http://` / `https://` URLs.

### Antivirus note (applies from v0.2.6)

The previous implementation wrote `.ps1` helper scripts into `%USERPROFILE%\.dsh\logs` and ran them with PowerShell — **Huorong was observed quarantining any newly created `.ps1` on sight**, which broke the watchdog, the launcher and the shortcut at once. **This version removes all `.ps1` files**:

- The restart watchdog and the app-window launcher are **plain Node `.cjs` scripts run by node.exe**; the desktop shortcut's target is literally `node.exe + a .cjs path`, indistinguishable from any dev tool;
- Shortcut creation/refresh is a **one-shot inline command** (system COM) at boot — no script file ever lands on disk for it; and it is spawned **visibly (minimized)**, because a hidden-spawned powershell can be silently killed by aggressive AV (the root cause of the "shortcut silently never appears" report), while a console powershell always works. The trade-off is a brief minimized window flash at boot;
- Opening URLs uses `rundll32 url.dll,FileProtocolHandler` (the classic Windows way) or native `open` / `xdg-open` elsewhere;
- All generated code is plain readable text — no obfuscation, no encoded payloads, no registry / scheduled-task / service / run-key touches;
- The only network activity is loopback port probes plus a version lookup on the npm registry.

The single resident process is one node.exe watchdog polling a request file once per second. To opt out set `watchdog: false`; after uninstalling, end that node.exe process and delete `dsh-restart-watchdog*` / `dsh-launch-web.cjs` under `%USERPROFILE%\.dsh\logs`. If your antivirus previously quarantined the old `.ps1` files there is nothing to restore — the new version no longer uses them; adding `%USERPROFILE%\.dsh\logs` to your antivirus trust zone is still a reasonable belt-and-suspenders measure.


---

**Language:** [English](README.en.md) | [中文](README.md)
