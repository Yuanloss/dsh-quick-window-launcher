# dsh-quick-window-launcher

Launch DeepSeek Harness web **in its own standalone app-style window** — from a desktop shortcut — instead of jumping to a default-browser tab — plus shutdown / restart power controls and an `open_web` tool.

On boot the plugin:

- **Generates a desktop shortcut** (`DeepSeek Harness.lnk`) that starts the harness if it isn't running, then opens it in a **dedicated app-mode window** (Chromium & Edge `--app=<url>`), not a tab. Falls back to the system default browser only when no Chromium-based browser is installed.
- **Adds a shutdown button** (⏻) at the sidebar foot — gracefully stops the harness (SIGTERM → dispose → flush persistence → exit).
- **Adds a restart button** (⟳) — gracefully stops the process, then relaunches a fresh instance via a persistent watchdog.
- **Adds three compact icon-only buttons** (30px, tooltip on hover) at the sidebar foot: shutdown / restart / DSH update check.
- **Adds a DSH update-check button** (⬇) — queries npm for the latest `@deepseek-ai/dsh` version and reports the **current version** and whether it is **up to date**.
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

On the first boot the plugin writes its helper scripts into `%USERPROFILE%\.dsh\logs`, starts the persistent restart watchdog, and creates/refreshes the `DeepSeek Harness.lnk` desktop shortcut.

> A restart is required for a new bundle to load. The desktop shortcut and the sidebar buttons appear once the plugin is active.

## What the desktop shortcut does

Double-click **`DeepSeek Harness`** on your desktop. The launcher:

1. Checks whether the harness is already listening on its port.
2. If not, starts it (hidden) with the same Node binary / entry the plugin itself runs under.
3. Waits until the UI is reachable.
4. **Opens it in a standalone app-mode window** — it finds Google Chrome or Microsoft Edge and launches it with `--app=<url>`, so the interface opens in its own borderless window (no tab strip, no address bar). If no Chromium-based browser is installed it falls back to your default browser.

## Manual desktop shortcut (fallback)

Normally the plugin creates `DeepSeek Harness.lnk` automatically on boot. If your desktop is redirected (e.g. by OneDrive) or the drive is not ready at boot time, create it manually with either of:

**A) Run the script the plugin already generated**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\logs\dsh-ensure-desktop-shortcut.ps1"
```

**B) One PowerShell command**
```powershell
$l = "$env:USERPROFILE\.dsh\logs\dsh-launch-web.ps1"
$d = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'DeepSeek Harness.lnk'))
$s.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$l`""
$s.WorkingDirectory = (Split-Path $l -Parent)
$s.Save()
```

> The result is logged to `%USERPROFILE%\.dsh\logs\dsh-shortcut.log` — check it if the shortcut fails to appear.

## Features

### Shutdown
A red power icon beside the sidebar foot. Asking for confirmation stops the harness gracefully — session data is flushed and the page is closed (or rewritten to a "closed" note if the browser blocks `window.close()`).

### Restart
A blue restart icon that gracefully stops the process and then relaunches a fresh instance. Restart is done by a **watchdog running outside the harness process tree** (the harness cleans up its own child processes, so a click-time spawn would die). The page shows a "restarting…" screen that polls until the fresh instance answers, then reloads.

### Button style
The three buttons are 30×30 icon-only circles (shutdown ⏻ red, restart ⟳ blue, DSH update ⬇ amber) with a fixed size and `flex: 0 0 auto` so the sidebar flex layout cannot stretch them out of shape; a `title` tooltip is shown on hover. No product CSS class names are targeted.

### `open_web` tool
The model can call `open_web` with an `https://…`/`http://…` URL to open it in the system default browser's new tab — matching the harness convention of opening web pages externally rather than framing them.

## Settings

The row accepts optional config (set it via a profile patch override):

| key | default | meaning |
| --- | --- | --- |
| `createShortcut` | `true` | generate/refresh the desktop shortcut to point at this plugin's app-window launcher (set `false` to opt out) |
| `desktopName` | `DeepSeek Harness` | base file name of the shortcut |

Example:

```yaml
- id: quick-window-launcher
  name: 'dsh-quick-window-launcher'
  config:
    createShortcut: true
    desktopName: 'DeepSeek Harness'
```

## Security

The HTTP routes (`/api/shutdown`, `/api/restart`) accept only loopback clients and reject cross-origin requests; they are POST-only. `open_web` only opens `http://` / `https://` URLs.


---

**Language:** [English](README.en.md) | [中文](README.md)
