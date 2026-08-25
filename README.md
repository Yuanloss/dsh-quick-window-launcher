# dsh-quick-window-launcher

Launch DeepSeek Harness web **in its own standalone app-style window** — from a desktop shortcut — instead of jumping to a default-browser tab — plus shutdown / restart power controls and an `open_web` tool.

On boot the plugin:

- **Generates a desktop shortcut** (`DeepSeek Harness.lnk`) that starts the harness if it isn't running, then opens it in a **dedicated app-mode window** (Chromium & Edge `--app=<url>`), not a tab. Falls back to the system default browser only when no Chromium-based browser is installed.
- **Adds a shutdown button** (⏻) at the sidebar foot — gracefully stops the harness (SIGTERM → dispose → flush persistence → exit).
- **Adds a restart button** (⟳) — gracefully stops the process, then relaunches a fresh instance via a persistent watchdog.
- **Adapts both buttons to the sidebar** (compact icon in the 56px rail, icon + label pill when expanded).
- **Registers an `open_web` model tool** — opens a URL in the system default browser's **new tab**.

Everything is derived from the live harness at runtime — the Node binary, the dsh entry script, the working directory, the listening port, and `~/.dsh/logs`. **No machine path, user name, or install location is hard-coded**, so it is safe to publish and works for anyone.

---

## Install

The plugin targets the `web` profile. Add it with the `dsh` plugin command:

```powershell
dsh plugin --profile web add <you>/dsh-quick-window-launcher
```

Then (re)start the harness:

```powershell
dsh web
```

On the first boot the plugin writes its helper scripts into `%USERPROFILE%\.dsh\logs`, starts the persistent restart watchdog, and creates the desktop shortcut (only if it doesn't already exist — it never overrides a shortcut you made yourself).

> A restart is required for a new bundle to load. The desktop shortcut and the sidebar buttons appear once the plugin is active.

## What the desktop shortcut does

Double-click **`DeepSeek Harness`** on your desktop. The launcher:

1. Checks whether the harness is already listening on its port.
2. If not, starts it (hidden) with the same Node binary / entry the plugin itself runs under.
3. Waits until the UI is reachable.
4. **Opens it in a standalone app-mode window** — it finds Google Chrome or Microsoft Edge and launches it with `--app=<url>`, so the interface opens in its own borderless window (no tab strip, no address bar). If no Chromium-based browser is installed it falls back to your default browser.

## Features

### Shutdown
A red power icon beside the sidebar foot. Asking for confirmation stops the harness gracefully — session data is flushed and the page is closed (or rewritten to a "closed" note if the browser blocks `window.close()`).

### Restart
A blue restart icon that gracefully stops the process and then relaunches a fresh instance. Restart is done by a **watchdog running outside the harness process tree** (the harness cleans up its own child processes, so a click-time spawn would die). The page shows a "restarting…" screen that polls until the fresh instance answers, then reloads.

### Adaptive placement (`props.wide`)
Both buttons use the sidebar's `wide` column-state prop from the `sidebar.footer.action` slot: in the rail they are icon-only circles, expanded they become icon + label pills. No product CSS class names are targeted.

### `open_web` tool
The model can call `open_web` with an `https://…`/`http://…` URL to open it in the system default browser's new tab — matching the harness convention of opening web pages externally rather than framing them.

## Settings

The row accepts optional config (set it via a profile patch override):

| key | default | meaning |
| --- | --- | --- |
| `createShortcut` | `true` | generate the desktop shortcut at boot (set `false` to opt out) |
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

## What changed relative to dsh-shutdown-button

- The old bundle hard-coded a `node.exe` path, a dsh entry path, a working directory, and a fixed port. Those are now derived from `process.execPath`, `process.argv[1]`, `process.cwd()`, and `webServer.port`.
- The old client CSS targeted build-hashed class names (`.hHd-Xa_root`). Those are gone; positioning now uses the slot's `wide` prop.
- The old launcher opened the default browser tab; this one opens a **standalone app-mode window** (Chromium/Edge `--app=<url>`), with a default-browser fallback.

## License

MIT
