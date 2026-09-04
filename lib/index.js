/**
 * dsh-quick-window-launcher — Host half.
 *
 * A fully generic desktop integration for the DeepSeek Harness web profile.
 * Nothing here hardcodes a machine user, a working directory, a Node binary,
 * or a dsh install path: every path is derived from the running host process
 * (process.execPath / process.argv / process.cwd) and the web server
 * (webServer.port). It therefore works for anyone who installs the plugin.
 *
 * Design note — ZERO PowerShell on disk and zero .ps1 files, ever:
 * aggressive antivirus products (observed live with Huorong) quarantine ANY
 * newly written .ps1 file, which broke every helper this plugin used to ship.
 * All automation is therefore plain Node.js:
 *   - the restart watchdog is a detached node process running a generated
 *     .cjs file (pure fs/process/net — no shells),
 *   - the app-window launcher is a generated .cjs invoked directly by
 *     node.exe (the desktop shortcut targets node.exe, not powershell.exe),
 *     with multi-signal liveness checks, its own dsh-launcher.log and a
 *     `--diagnose` subcommand,
 *   - shortcut creation/refresh uses a ONE-SHOT inline PowerShell command
 *     (WScript.Shell COM) spawned VISIBLY (minimized), because a
 *     hidden-spawned powershell can be silently killed by aggressive AV
 *     (observed with Huorong), while a manual console powershell always
 *     works; the host pre-resolves the desktop dir (config → registry →
 *     default) and logs every step from the outside,
 *   - opening URLs uses rundll32 FileProtocolHandler (Windows) or the native
 *     `open` / `xdg-open` elsewhere.
 *
 * What it does, at boot:
 *   1. Derives the runtime facts: node binary, dsh entry script + arg list,
 *      working directory, listening port, and the user's ~/.dsh/logs dir.
 *   2. Writes two helper .cjs files into ~/.dsh/logs (app-window launcher,
 *      restart watchdog) with those facts baked in, then starts the watchdog
 *      as a detached node process outside the host process tree, and
 *      generates a desktop shortcut that opens the harness in its OWN
 *      standalone app-mode window (Chromium `--app=<url>`), with a
 *      default-browser fallback when no Chromium is found.
 *   3. Registers two loopback-only HTTP routes on the web server:
 *        POST /api/shutdown  — graceful stop (SIGTERM -> dispose -> flush -> exit)
 *        POST /api/restart   — graceful stop, then a fresh instance via watchdog
 *   4. Registers a model-facing tool `open_web` that opens a URL in the system
 *      default browser's new tab.
 *
 * Restart keeps the same architecture as before: the graceful shutdown child
 * processes get cleaned up by the harness, so the actual relaunch must be
 * driven by a watchdog running OUTSIDE the host process tree. The plugin
 * writes the watchdog script at boot (when the host is stable) and launches
 * it detached; /api/restart only drops a request file and lets the watchdog
 * do the real restart after this process exits.
 *
 * Security:
 * - Only loopback clients are accepted on /api/* (403 otherwise).
 * - Cross-origin requests are refused via the Origin check, POST-only.
 * - open_web only opens http:// / https:// URLs.
 *
 * @module dsh-quick-window-launcher
 */

import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, openSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-quick-window-launcher'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const EXIT_BACKSTOP_MS = 10000
const OLD_PROCESS_GRACE_SECONDS = 45
const DEFAULT_DESKTOP_NAME = 'DeepSeek Harness'

// Helper artifact names. The "-v2" suffixes keep a clean namespace away from
// any legacy PowerShell-era watchdog still resident on upgraded machines: the
// old watchdog keeps polling its own (never-written) request file harmlessly.
const WATCHDOG_CJS = 'dsh-restart-watchdog.cjs'
const LAUNCHER_CJS = 'dsh-launch-web.cjs'
const REQ_FILE = 'dsh-restart-request-v2.json'
const PROC_FILE = 'dsh-restart-processing-v2.json'
const PID_FILE = 'dsh-restart-watchdog-v2.pid'
const TRACE_FILE = 'dsh-restart-watchdog-v2.log'

/**
 * Resolve the real Desktop directory, in priority order:
 *   1. `desktopPath` config (explicit user choice — OneDrive/redirected
 *      desktops, network drives, anything GetFolderPath misses);
 *   2. Windows: the "User Shell Folders\Desktop" registry value (catches
 *      OneDrive redirections) read via reg.exe — still no PowerShell;
 *   3. ~/Desktop fallback.
 * Existence is verified; a configured-but-missing path falls through.
 * @param {object} r - runtime facts (may carry r.desktopPath).
 * @returns {string} an existing directory, or '' when nothing resolves.
 */
function resolveDesktopDir(r) {
  if (typeof r.desktopPath === 'string' && r.desktopPath.trim().length > 0) {
    const d = r.desktopPath.trim()
    if (existsSync(d)) return d
  }
  if (process.platform === 'win32') {
    try {
      const res = spawnSync('reg.exe', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop',
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      if (res.status === 0 && res.stdout) {
        const m = /Desktop\s+REG_[A-Z_]+\s+(.+)/.exec(res.stdout)
        if (m) {
          const raw = m[1].trim()
          const expanded = raw.replace(/%([^%]+)%/g, (_, k) => process.env[k] || '%' + k + '%')
          if (expanded && existsSync(expanded)) return expanded
        }
      }
    } catch { /* fall through */ }
  }
  const fallback = join(homedir(), 'Desktop')
  return existsSync(fallback) ? fallback : ''
}

/**
 * Build the ONE-SHOT inline command that creates/refreshes the desktop
 * shortcut. No script file is ever written to disk (antivirus products
 * quarantine new .ps1 files on sight); the shortcut targets node.exe running
 * the generated launcher, so nothing on the desktop references PowerShell
 * either. `desktopDir` (when resolved by the host from desktopPath / registry)
 * overrides the script's own Desktop lookup, so OneDrive-redirected desktops
 * are handled even when GetFolderPath is slow or wrong.
 * @param {object} r - runtime facts.
 * @param {string} launcherPath - absolute path to the launcher .cjs.
 * @param {string} iconPath - absolute path to the bundled .ico (may be '').
 * @param {string} desktopName - base file name of the shortcut.
 * @param {string} desktopDir - pre-resolved desktop dir ('' = let PS resolve).
 * @returns {{cmd:string,args:string[]}} spawn target for the refresh.
 */
function shortcutRefreshCommand(r, launcherPath, iconPath, desktopName, desktopDir) {
  const name = (typeof desktopName === 'string' && desktopName.length > 0) ? desktopName : DEFAULT_DESKTOP_NAME
  // Single-quote every literal (doubling embedded apostrophes). The finished
  // command text must contain NO double-quote character at all: node escapes
  // embedded " as \" in Windows argv and powershell.exe -Command chokes on
  // that silently (observed: process exits without running anything). The one
  // pair of quotes the .lnk Arguments needs is produced at run time via
  // [char]34 instead.
  const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const ps = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$lz=${sq(join(r.logsDir, 'dsh-shortcut.log'))}`,
    `$t=''`,
    `try{`,
    desktopDir && desktopDir.length > 0
      // Host already resolved the desktop (config/registry); trust it.
      ? `$d=${sq(desktopDir)}`
      // Resolve the real Desktop (OneDrive redirections can be slow at boot).
      : `$d=''` + `;` + `for($i=0;$i -lt 6 -and -not $d;$i++){$d=[Environment]::GetFolderPath('Desktop');if(-not $d){Start-Sleep -Seconds 2}}`,
    `if(-not $d){$d=${sq(join(homedir(), 'Desktop'))}}`,
    `$lnk=Join-Path $d (${sq(name)}+'.lnk')`,
    `$sh=New-Object -ComObject WScript.Shell`,
    `$sc=$sh.CreateShortcut($lnk)`,
    `$sc.TargetPath=${sq(r.node)}`,
    `$q=[char]34`,
    `$sc.Arguments=$q+${sq(launcherPath)}+$q`,
    `$sc.WorkingDirectory=${sq(r.logsDir)}`,
    iconPath ? `$sc.IconLocation=${sq(iconPath + ',0')}` : '',
    `$sc.Description=${sq(name)}`,
    `$sc.Save()`,
    `$t='refreshed '+$sc.TargetPath`,
    `}catch{$t='FAILED '+$_.Exception.Message}`,
    // Always leave a trace so failures are never silent again.
    `Add-Content -Path $lz -Value (((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))+' '+$t)`,
  ].filter(Boolean).join('; ')
  // Spawned VISIBLY (minimized): a hidden-spawned powershell.exe can be
  // silently killed by aggressive AV (observed with Huorong — the reporter's
  // manual console powershell always worked). A brief minimized console at
  // boot is the price for a shortcut that actually appears. No detached:true
  // (powershell dies instantly under DETACHED_PROCESS), no windowsHide.
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Minimized', '-Command', ps] }
}

/**
 * Create/refresh the desktop shortcut. Resolves the desktop dir in the HOST
 * (config → registry → default) so OneDrive-redirected desktops are handled,
 * then spawns the one-shot inline PowerShell command VISIBLY (minimized) —
 * hidden spawns can be silently killed by aggressive AV. Always leaves outer
 * traces in dsh-shortcut.log (attempt / spawn error / exit code), so a
 * failure can never be silent again, and logs the manual fallback command.
 * @param {object} r - runtime facts (r.desktopPath honored).
 * @param {string} launcherPath - absolute path to the launcher .cjs.
 * @param {string} iconPath - absolute path to the bundled .ico (may be '').
 * @param {string} desktopName - base file name of the shortcut.
 */
function refreshDesktopShortcut(r, launcherPath, iconPath, desktopName) {
  const logPath = join(r.logsDir, 'dsh-shortcut.log')
  const log = (m) => { try { appendFileSync(logPath, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + m + '\n') } catch {} }
  try {
    const desktopDir = resolveDesktopDir(r)
    log('attempting shortcut refresh: desktop=' + (desktopDir || '(let PS resolve)'))
    const { cmd, args } = shortcutRefreshCommand(r, launcherPath, iconPath, desktopName, desktopDir)
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', (e) => log('spawn error: ' + String((e && e.message) || e)))
    child.on('exit', (code, sig) => {
      if (code === 0) return
      log('powershell exited code=' + code + ' signal=' + String(sig) + '; manual fallback: see README "手动创建桌面快捷方式（兜底）"')
    })
  } catch (e) {
    log('FAILED: ' + String((e && e.message) || e))
  }
}

/** Parse a request body (bounded); unused but harmless. */
async function readBody(req, limit = 65536) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total > limit) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Gate one request: loopback + origin + POST. Returns true when allowed. */
function authorized(req, res) {
  const remote = req.socket?.remoteAddress ?? ''
  if (!LOOPBACK.has(remote)) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback-only' } })
    return false
  }
  const origin = req.headers['origin']
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-origin refused' } })
    return false
  }
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
    return false
  }
  return true
}

/** Trigger the graceful shutdown path (same as SIGTERM -> profile boot). */
function gracefulExit() {
  setImmediate(() => {
    try { process.emit('SIGTERM') } catch { process.exit(0) }
  })
  setTimeout(() => {
    try { process.exit(0) } catch { /* already exiting */ }
  }, EXIT_BACKSTOP_MS)
}

/** Validate that a URL is an http/https web URL. Throws otherwise. */
function assertOpenableUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http:// and https:// URLs can be opened')
  }
  return url
}

/**
 * Open a URL in the system default browser (new tab). No PowerShell: on
 * Windows rundll32's FileProtocolHandler is the quiet, AV-invisible classic;
 * macOS/Linux use their native opener.
 */
function openOnPlatform(url) {
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let cmd
    let args
    if (platform === 'win32') {
      cmd = 'rundll32.exe'
      args = ['url.dll,FileProtocolHandler', url]
    } else if (platform === 'darwin') {
      cmd = 'open'
      args = [url]
    } else {
      cmd = 'xdg-open'
      args = [url]
    }
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    child.on('error', (e) => { settled = true; reject(e) })
    child.on('spawn', () => { if (!settled) { settled = true; resolve() } })
    // rundll32 may exit non-zero even on success; the spawn succeeding is the
    // signal we care about.
    child.on('close', () => { if (!settled) { settled = true; resolve() } })
  })
}

/**
 * The persistent restart watchdog, as PURE NODE (a generated .cjs run by the
 * same node binary). Polls a request file; on restart it waits a grace period
 * for the old pid to exit (force-killing only as a last resort), then spawns
 * a fresh host instance detached. ASCII-safe because JSON.stringify output is
 * escaped; runs identically on win32/darwin/linux.
 * @param {object} r - runtime facts.
 * @returns {string} the watchdog CommonJS source.
 */
function watchdogScript(r) {
  const cfg = {
    node: r.node,
    entry: r.entry,
    args: r.args,
    workdir: r.workdir,
    logDir: r.logsDir,
    graceSec: OLD_PROCESS_GRACE_SECONDS,
    reqFile: REQ_FILE,
    procFile: PROC_FILE,
    pidFile: PID_FILE,
    traceFile: TRACE_FILE,
  }
  return `/* Generated by ${PLUGIN_NAME}. Pure Node restart watchdog. */
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const CFG = ${JSON.stringify(cfg, null, 2)}

const reqPath = path.join(CFG.logDir, CFG.reqFile)
const procPath = path.join(CFG.logDir, CFG.procFile)
const pidPath = path.join(CFG.logDir, CFG.pidFile)
const tracePath = path.join(CFG.logDir, CFG.traceFile)

function trace(msg) {
  try { fs.appendFileSync(tracePath, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + msg + '\\n') } catch {}
}
function alive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
function relaunch() {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const out = fs.openSync(path.join(CFG.logDir, 'dsh-web-' + stamp + '.out.log'), 'a')
  const err = fs.openSync(path.join(CFG.logDir, 'dsh-web-' + stamp + '.err.log'), 'a')
  const child = spawn(CFG.node, [CFG.entry].concat(CFG.args, ['--no-open']), {
    cwd: CFG.workdir, detached: true, windowsHide: true, stdio: ['ignore', out, err],
  })
  child.unref()
  trace('started fresh instance pid ' + child.pid)
  try { fs.unlinkSync(procPath) } catch {}
  // Release the lock so the next restart request is processed (v0.2.4 kept
  // busy=true forever here, permanently deafening the watchdog after its
  // first restart).
  busy = false
}

try { fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, ts: Date.now() })) } catch {}
trace('watchdog loop started (pid ' + process.pid + '); waiting for restart requests')

let busy = false
setInterval(() => {
  // Heartbeat: proves this exact process still owns the pid file, so a stale
  // file whose pid the OS recycled to something else cannot suppress startup.
  try { fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, ts: Date.now() })) } catch {}
  if (busy) return
  if (!fs.existsSync(reqPath)) return
  let oldPid = 0
  try { fs.renameSync(reqPath, procPath) } catch { return }
  busy = true
  try {
    try { oldPid = Number(JSON.parse(fs.readFileSync(procPath, 'utf8')).oldPid) || 0 } catch {}
    trace('restart requested; old pid=' + oldPid + '; grace up to ' + CFG.graceSec + ' s')
    const deadline = Date.now() + CFG.graceSec * 1000
    const tick = () => {
      if (alive(oldPid)) {
        if (Date.now() < deadline) { setTimeout(tick, 1000); return }
        trace('old process still alive after grace; force-killing pid ' + oldPid)
        try { process.kill(oldPid) } catch {}
        setTimeout(relaunch, 2000)
        return
      }
      trace('old process exited')
      relaunch()
    }
    tick()
  } catch (e) {
    // Never go deaf: any transient error during claim/grace/relaunch must
    // release the lock so the next request is seen. (busy stayed true forever
    // in v0.2.4 — each watchdog processed exactly ONE restart, then silently
    // ignored every later request while its heartbeat kept looking healthy.)
    trace('restart processing failed: ' + (e && e.message))
    try { fs.unlinkSync(procPath) } catch {}
    busy = false
  }
}, 1000)
`
}

/**
 * The app-window launcher as PURE NODE (a generated .cjs run directly by
 * node.exe — this is what the desktop shortcut targets). Starts the harness
 * if it is not listening yet, then opens the UI in a standalone Chromium
 * app-mode window (--app=), falling back to the system default browser.
 *
 * Robustness (issue report 2026-09-02):
 *  - multi-signal liveness: "port closed" alone no longer means "not
 *    running". If the task-board ledger lock records a LIVE owner pid while
 *    the port is closed, the previous instance is half-alive — spawning a
 *    second one would die inside task-board's single-instance guard. In that
 *    case the launcher does NOT spawn; it logs and opens a local error page
 *    with concrete next steps.
 *  - own log: every decision (spawn, readiness, window, failure) is written
 *    to dsh-launcher.log, so failures are never silent.
 *  - early-exit detection: if the spawned child dies before readiness, the
 *    launcher logs the exit code and opens the error page instead of waiting
 *    60 s and opening a window pointed at a dead port.
 *  - `--diagnose`: prints port / lock / watchdog / log-tail state and exits.
 * @param {object} r - runtime facts.
 * @returns {string} the launcher CommonJS source.
 */
function launchWebScript(r) {
  const cfg = {
    node: r.node,
    entry: r.entry,
    args: r.args,
    workdir: r.workdir,
    port: r.port,
    logDir: r.logsDir,
    platform: process.platform,
  }
  return `/* Generated by ${PLUGIN_NAME}. Pure Node app-window launcher. */
'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
const { spawn } = require('child_process')
const CFG = ${JSON.stringify(cfg, null, 2)}
const url = 'http://127.0.0.1:' + CFG.port
const logPath = path.join(CFG.logDir, 'dsh-launcher.log')
function log(m) {
  try { fs.appendFileSync(logPath, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + m + '\\n') } catch {}
}
function alive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
function portOpen() {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: CFG.port })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}
function httpReady() {
  return new Promise((resolve) => {
    const rq = http.get(url + '/', (res) => { res.resume(); resolve(true) })
    rq.on('error', () => resolve(false))
    rq.setTimeout(1500, () => { rq.destroy(); resolve(false) })
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** task-board ledger lock owner (the single-instance guard of another plugin). */
function taskBoardLockOwner() {
  try {
    const p = path.join(path.dirname(CFG.logDir), 'task-board', 'ledger-v2.lock')
    const o = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { pid: Number(o.pid) || 0, startedAt: Number(o.startedAt) || 0 }
  } catch { return { pid: 0, startedAt: 0 } }
}
function watchdogState() {
  try {
    const p = path.join(CFG.logDir, 'dsh-restart-watchdog-v2.pid')
    const o = JSON.parse(fs.readFileSync(p, 'utf8'))
    const pid = Number(o.pid) || 0
    const ts = Number(o.ts) || 0
    const fresh = ts > 0 && Date.now() - ts < 30000
    return { pid, heartbeatFresh: fresh, alive: alive(pid) }
  } catch { return { pid: 0, heartbeatFresh: false, alive: false } }
}
function openInDefaultBrowser(target) {
  try {
    if (CFG.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], { stdio: 'ignore', windowsHide: true }).unref()
    else if (CFG.platform === 'darwin') spawn('open', [target], { stdio: 'ignore' }).unref()
    else spawn('xdg-open', [target], { stdio: 'ignore' }).unref()
  } catch {}
}
/** Write a local HTML diagnostic page and open it — never a window on a dead port. */
function openErrorPage(msgs) {
  try {
    const p = path.join(CFG.logDir, 'dsh-launch-error.html')
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const body = msgs.map((m) => '<p>' + esc(m) + '</p>').join('')
    fs.writeFileSync(p, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Harness 启动失败</title>'
      + '<style>body{background:#0f1115;color:#e5e7eb;font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px}'
      + 'h1{font-size:20px}code{background:rgba(255,255,255,.08);border-radius:4px;padding:2px 6px;font-size:12px}'
      + 'p{font-size:13px;line-height:1.7;opacity:.9}</style></head><body><h1>⏻ DeepSeek Harness 启动失败</h1>' + body + '</body></html>')
    openInDefaultBrowser('file:///' + p.replace(/\\\\/g, '/'))
  } catch {}
}

async function main() {
  log('launcher invoked (pid ' + process.pid + ')')

  // ── --diagnose: print current state, exit ─────────────────────────────
  if (process.argv.includes('--diagnose')) {
    const open = await portOpen()
    const lock = taskBoardLockOwner()
    const wd = watchdogState()
    console.log('[dsh-launcher] port ' + CFG.port + ' open: ' + open)
    console.log('[dsh-launcher] task-board lock owner: pid=' + lock.pid + ' alive=' + alive(lock.pid) + ' startedAt=' + lock.startedAt)
    console.log('[dsh-launcher] watchdog: pid=' + wd.pid + ' alive=' + wd.alive + ' heartbeatFresh=' + wd.heartbeatFresh)
    console.log('[dsh-launcher] logDir: ' + CFG.logDir)
    try {
      const tail = fs.readFileSync(logPath, 'utf8').trim().split('\\n').slice(-10)
      console.log('[dsh-launcher] last launcher log lines:'); tail.forEach((l) => console.log('  ' + l))
    } catch {}
    return
  }

  if (await portOpen()) {
    log('already listening on ' + CFG.port + '; opening window')
  } else {
    // Port closed. Was the previous instance really gone?
    const lock = taskBoardLockOwner()
    if (alive(lock.pid)) {
      log('REFUSE: harness pid ' + lock.pid + ' is alive but not serving ' + CFG.port + '; not spawning a second instance')
      openErrorPage([
        '检测到上一个 DeepSeek Harness 进程（PID <code>' + lock.pid + '</code>）仍然存活，但没有在监听端口 <code>' + CFG.port + '</code>。',
        '为避免与它冲突（任务看板账本锁被占用），启动器<b>没有</b>再启动新实例。',
        '处理办法（二选一）：',
        '1) 结束旧进程后重试：<code>taskkill /F /PID ' + lock.pid + '</code>，然后再次双击本快捷方式；',
        '2) 若旧进程已不存在但锁未清理：删除 <code>C:\\\\Users\\\\<你>\\\\.dsh\\\\task-board\\\\ledger-v2.lock</code> 后重试。',
        '详细日志：<code>' + logPath + '</code>（或运行 <code>node "' + path.join(CFG.logDir, 'dsh-launch-web.cjs') + '" --diagnose</code>）',
      ])
      return
    }

    const out = fs.openSync(path.join(CFG.logDir, 'dsh-web.out.log'), 'a')
    const err = fs.openSync(path.join(CFG.logDir, 'dsh-web.err.log'), 'a')
    const child = spawn(CFG.node, [CFG.entry].concat(CFG.args, ['--no-open']), {
      cwd: CFG.workdir, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    })
    child.unref()
    log('spawned fresh instance pid ' + child.pid + ' (port was closed, no live lock owner)')
    let exitedEarly = null
    child.on('exit', (code, sig) => {
      exitedEarly = { code, sig }
      log('child exited before readiness: code=' + code + ' signal=' + sig)
    })
    child.on('error', (e) => log('child spawn error: ' + (e && e.message)))

    let ready = false
    for (let i = 0; i < 60; i++) {
      await sleep(1000)
      if (exitedEarly) break
      if (await httpReady()) { ready = true; break }
    }
    if (ready) {
      log('harness ready after ' + (i + 1) + ' s')
    } else if (exitedEarly) {
      log('NOT opening a window: spawned instance died (code ' + exitedEarly.code + ')')
      openErrorPage([
        '启动的 DeepSeek Harness 实例在就绪前就退出了（退出码 <code>' + exitedEarly.code + '</code>，信号 <code>' + String(exitedEarly.sig) + '</code>）。',
        '请查看启动日志：<code>' + path.join(CFG.logDir, 'dsh-web.err.log') + '</code>',
        '常见原因：端口/锁被其他实例占用、或其他插件启动失败。修复后再次双击本快捷方式。',
        '详细诊断：<code>node "' + path.join(CFG.logDir, 'dsh-launch-web.cjs') + '" --diagnose</code>',
      ])
      return
    } else {
      log('warn: not ready after 60 s but child alive; opening window anyway (best effort)')
    }
  }

  // Standalone app window: prefer a Chromium browser in --app mode.
  const pf = process.env['ProgramFiles'] || ''
  const pf86 = process.env['ProgramFiles(x86)'] || ''
  const local = process.env['LocalAppData'] || ''
  const j = (...p) => path.join(...p.filter(Boolean))
  const candidates = [
    j(pf, 'Google\\\\Chrome\\\\Application\\\\chrome.exe'),
    j(pf86, 'Google\\\\Chrome\\\\Application\\\\chrome.exe'),
    j(local, 'Google\\\\Chrome\\\\Application\\\\chrome.exe'),
    j(pf, 'Microsoft\\\\Edge\\\\Application\\\\msedge.exe'),
    j(pf86, 'Microsoft\\\\Edge\\\\Application\\\\msedge.exe'),
  ]
  let browser = ''
  for (const c of candidates) { try { if (c && fs.existsSync(c)) { browser = c; break } } catch {} }

  if (CFG.platform === 'win32') {
    if (browser) {
      // A dedicated browser profile makes --app open a NEW standalone window
      // rather than a tab inside the already-running browser.
      const winProfile = path.join(CFG.logDir, 'window-profile')
      try { fs.mkdirSync(winProfile, { recursive: true }) } catch {}
      spawn(browser, ['--app=' + url, '--user-data-dir=' + winProfile], { detached: true, stdio: 'ignore' }).unref()
      log('opened app window via ' + browser)
    } else {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true }).unref()
      log('opened default browser via rundll32')
    }
  } else if (CFG.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore' }).unref()
    log('opened default browser via open')
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore' }).unref()
    log('opened default browser via xdg-open')
  }
}

main().catch((e) => { log('launcher fatal: ' + (e && e.message)); process.exitCode = 1 })
`
}

/**
 * Write the helper .cjs scripts into the logs dir, start the detached node
 * watchdog, and refresh the desktop shortcut (pure Node .lnk writer, outer
 * logging in dsh-shortcut.log). Called from apply at boot, when the host is
 * stable.
 * @param {object} ctx - the Cordis context.
 * @param {object} r - runtime facts.
 * @param {object} cfg - plugin config.
 * @param {string} desktopName - base file name of the shortcut.
 */
function bootstrapScripts(ctx, r, cfg, desktopName) {
  try {
    if (!existsSync(r.logsDir)) mkdirSync(r.logsDir, { recursive: true })
    const watchPath = join(r.logsDir, WATCHDOG_CJS)
    const launchPath = join(r.logsDir, LAUNCHER_CJS)

    writeFileSync(watchPath, watchdogScript(r), 'utf8')
    // The desktop shortcut targets this launcher directly; without writing it
    // here the .lnk would point at a file that never exists.
    writeFileSync(launchPath, launchWebScript(r), 'utf8')

    // Start the restart watchdog as a detached node process (outside this
    // process tree). Re-running is safe: the watchdog dedupes nothing, but it
    // is idempotent per request file and cheap; still, skip if a previous
    // watchdog pid is alive.
    if (cfg.watchdog !== false && !watchdogAlive(r.logsDir)) {
      const child = spawn(r.node, [watchPath], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      child.unref()
    }

    // Generate/refresh the desktop shortcut so it points at this plugin's own
    // app-window launcher. Pure Node: writes the .lnk directly (no PowerShell
    // subprocess that an antivirus could silently kill), and logs every step
    // in dsh-shortcut.log from the OUTSIDE.
    if (cfg.createShortcut !== false) {
      refreshDesktopShortcut(r, launchPath, resolveBundledIcon(), desktopName)
    }
  } catch (e) {
    ctx?.logger?.error?.(PLUGIN_NAME + ': bootstrap failed: ' + String((e && e.message) || e))
  }
}

/**
 * True when the watchdog pid file carries a FRESH heartbeat (within 30 s) from
 * a still-living process. The heartbeat protects against a stale pid that the
 * OS has since recycled to an unrelated process.
 */
function watchdogAlive(logsDir) {
  try {
    const raw = JSON.parse(readFileSync(join(logsDir, PID_FILE), 'utf8'))
    const pid = Number(raw && raw.pid)
    const ts = Number(raw && raw.ts)
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (Number.isFinite(ts) && ts > 0 && Date.now() - ts > 30000) return false
    try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
  } catch {
    return false
  }
}

/** Resolve the bundled launcher icon path, or '' when the package lacks one. */
function resolveBundledIcon() {
  try {
    const url = new URL('../assets/launcher.ico', import.meta.url)
    const path = fileURLToPath(url)
    return existsSync(path) ? path : ''
  } catch {
    return ''
  }
}

/**
 * Register the model-facing `open_web` tool. Registers as a plain definition so
 * it does not need to import @deepseek-ai/dsh-tools (which a standalone plugin
 * must not assume is hoisted to the profile node_modules).
 * @param {object} ctx - the Cordis context.
 */
function registerOpenWeb(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) return
  ctx.effect(() => tools.register({
    name: 'open_web',
    description: 'Open a URL in the system default browser (a new tab). Use this when you need to open or visit a web page for the user instead of fetching its content yourself.',
    parameters: {
      url: { type: 'string', required: true, description: 'The web URL to open, e.g. https://example.com. Only http:// and https:// are allowed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          opened: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.opened
          ? 'Opened ' + value.url + ' in the default browser.'
          : 'Could not open ' + value.url + ' in the default browser.',
      }],
    },
    async execute(args) {
      let url = String((args && args.url) || '').trim()
      try {
        url = assertOpenableUrl(url).href
      } catch (e) {
        return { opened: false, url: String(url || '') }
      }
      try {
        await openOnPlatform(url)
      } catch (e) {
        return { opened: false, url }
      }
      return { opened: true, url }
    },
  }))
}

/**
 * Derive the runtime facts this plugin needs, from the live host ONLY.
 * @param {object} webServer - the webServer service.
 * @returns {{node:string,entry:string,args:string[],workdir:string,port:number,url:string,logsDir:string,runtimeMask:object}}
 */
function deriveRuntime(webServer) {
  const node = process.execPath
  // The host is launched as `node <entry> <args...>`; re-run the same boot.
  const entry = (typeof process.argv[1] === 'string' && process.argv[1].length > 0) ? process.argv[1] : node
  const args = (Array.isArray(process.argv) ? process.argv.slice(2) : []).filter((a) => typeof a === 'string' && a.length > 0)
  const workdir = process.cwd()
  let port = typeof webServer?.port === 'number' ? webServer.port : 3080
  if (typeof port !== 'number' || port <= 0) {
    const m = /:(\d+)/.exec(process.env.DSH_WEB_URL || '')
    port = m ? Number(m[1]) : 3080
  }
  return {
    node,
    entry,
    args,
    workdir,
    port,
    url: 'http://127.0.0.1:' + port,
    logsDir: join(homedir(), '.dsh', 'logs'),
  }
}

/**
 * Parse a SemVer-ish version into comparable parts.
 * @param {string} value - a version string like 0.1.1-rc.2.
 * @returns {{major:number,minor:number,patch:number,pre:string}|null} the parsed parts.
 */
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' }
}

/**
 * Whether `latest` is a newer release than `current`.
 * @param {string} latest - the candidate newest version.
 * @param {string} current - the installed version.
 * @returns {boolean} true when an update is available.
 */
function isNewerVersion(latest, current) {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  if (a.patch !== b.patch) return a.patch > b.patch
  // Same numeric core: a release beats the same version's prerelease.
  if (a.pre === b.pre) return false
  if (b.pre === '') return false
  if (a.pre === '') return true
  return a.pre > b.pre
}

/** Read the installed (running) dsh version from the executing entry's package.json. */
function readInstalledDshVersion() {
  const entry = (typeof process.argv[1] === 'string' && process.argv[1].length > 0) ? process.argv[1] : ''
  if (!entry) return 'unknown'
  try {
    // argv[1] = <dsh>/lib/bin.js  ->  ../package.json = <dsh>/package.json
    const pkgPath = join(dirname(entry), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Query the npm registry for the latest @deepseek-ai/dsh version. */
async function queryNpmLatest() {
  const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest')
  if (!res.ok) throw new Error('npm registry returned ' + res.status)
  const data = await res.json()
  return (data && typeof data.version === 'string') ? data.version : ''
}

/** Check whether a newer dsh is available and report the current/latest versions. */
async function checkDshUpdate() {
  const current = readInstalledDshVersion()
  const latest = await queryNpmLatest()
  const updateAvailable = latest.length > 0 && isNewerVersion(latest, current)
  return { current, latest, updateAvailable }
}

const DSH_PACKAGE_SPEC = '@deepseek-ai/dsh@latest'

/**
 * Detect the package manager on PATH (npm preferred, then pnpm, then yarn).
 * Uses `where`/`which` (PATH lookup) instead of running the tool — npm.cmd
 * cannot be spawned directly by Node on Windows, but `where` resolves it.
 */
function detectPackageManager() {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  for (const pm of ['npm', 'pnpm', 'yarn']) {
    try {
      const args = process.platform === 'win32' ? [pm + '.cmd', pm + '.exe', pm] : [pm]
      const r = spawnSync(finder, args, { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      if (r.status === 0) return pm
    } catch { /* try next */ }
  }
  return ''
}

/**
 * Run the dsh update in a way the user can SEE and control.
 *  - win32: opens a VISIBLE cmd window (`/k` keeps it open) running the
 *    package-manager install — output, UAC and errors are all visible, and a
 *    visible spawn is what survives aggressive AV (hidden ones get killed).
 *  - other platforms: detached background install with output to log files.
 * @param {object} r - runtime facts.
 * @returns {{ok:boolean,error?:{code:string,message:string},value?:{mode:string,pm:string,cmd:string,logPath?:string}}}
 */
function runDshUpdate(r) {
  const pm = detectPackageManager()
  if (!pm) return { ok: false, error: { code: 'no-package-manager', message: '未在 PATH 中找到 npm / pnpm / yarn' } }
  const cmdLine = pm + ' install -g ' + DSH_PACKAGE_SPEC
  try {
    if (process.platform === 'win32') {
      // Visible terminal: no windowsHide, /k keeps the window open so the
      // user sees the full npm output and any UAC/权限 prompt.
      const child = spawn('cmd.exe', ['/d', '/k', pm, 'install', '-g', DSH_PACKAGE_SPEC], { stdio: 'ignore' })
      child.on('error', () => { /* visible cmd; nothing to relay */ })
      return { ok: true, value: { mode: 'terminal', pm, cmd: cmdLine } }
    }
    const out = openSync(join(r.logsDir, 'dsh-update.out.log'), 'a')
    const err = openSync(join(r.logsDir, 'dsh-update.err.log'), 'a')
    const child = spawn(pm, ['install', '-g', DSH_PACKAGE_SPEC], {
      detached: true, stdio: ['ignore', out, err],
    })
    child.unref()
    return { ok: true, value: { mode: 'background', pm, cmd: cmdLine, logPath: join(r.logsDir, 'dsh-update.err.log') } }
  } catch (e) {
    return { ok: false, error: { code: 'spawn', message: String((e && e.message) || e) } }
  }
}

export default {
  inject: ['webServer'],
  apply(ctx, config) {
    const webServer = ctx.webServer
    const cfg = config || {}
    const desktopName = (typeof cfg.desktopName === 'string' && cfg.desktopName.length > 0) ? cfg.desktopName : DEFAULT_DESKTOP_NAME
    const r = deriveRuntime(webServer)
    // Optional explicit desktop directory (OneDrive-redirected / network
    // desktops, or any machine where automatic resolution misbehaves).
    r.desktopPath = (typeof cfg.desktopPath === 'string' && cfg.desktopPath.trim().length > 0) ? cfg.desktopPath.trim() : ''

    bootstrapScripts(ctx, r, cfg, desktopName)

    // Optional tool + prompt guidance. Wrapped so a failure here degrades
    // gracefully rather than breaking a fail-loud boot (the shutdown/restart
    // routes above remain fully functional).
    try {
      registerOpenWeb(ctx)
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        ctx.effect(() => systemPrompt.section({
          name: 'tool:open_web',
          order: 115,
          text: 'When you need to open or visit a web page for the user, call open_web with the URL; it opens the URL in the system default browser in a new tab. Do not embed or render the page yourself unless the user asks for its content.',
        }))
      }
    } catch (e) {
      ctx?.logger?.error?.(PLUGIN_NAME + ': open_web registration failed: ' + String((e && e.message) || e))
    }

    const shutdownHandler = async (req, res) => {
      try {
        if (!authorized(req, res)) return
        await readBody(req)
        writeJson(res, 200, { ok: true, value: { shuttingDown: true } })
        gracefulExit()
      } catch (e) {
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: String((e && e.message) || e) } })
      }
    }

    const restartHandler = async (req, res) => {
      try {
        if (!authorized(req, res)) return
        await readBody(req)
        if (cfg.watchdog !== false) {
          writeFileSync(join(r.logsDir, REQ_FILE), JSON.stringify({ oldPid: process.pid, ts: Date.now() }))
        }
        writeJson(res, 200, { ok: true, value: { restarting: cfg.watchdog !== false } })
        gracefulExit()
      } catch (e) {
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: String((e && e.message) || e) } })
      }
    }

    const dshUpdateHandler = async (req, res) => {
      try {
        if (!authorized(req, res)) return
        await readBody(req)
        const info = await checkDshUpdate()
        writeJson(res, 200, { ok: true, value: info })
      } catch (e) {
        writeJson(res, 200, { ok: false, value: { error: String((e && e.message) || e) } })
      }
    }

    const dshUpdateRunHandler = async (req, res) => {
      try {
        if (!authorized(req, res)) return
        await readBody(req)
        const out = runDshUpdate(r)
        if (!out.ok) {
          writeJson(res, 500, { ok: false, error: out.error })
          return
        }
        writeJson(res, 200, { ok: true, value: out.value })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: String((e && e.message) || e) } })
      }
    }

    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/shutdown', handler: shutdownHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/restart', handler: restartHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/dsh-update-check', handler: dshUpdateHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/dsh-update-run', handler: dshUpdateRunHandler }))
  },
}

// Exported so the generated scripts can be inspected/tested; not used by the
// loader at runtime.
export {
  deriveRuntime,
  watchdogScript,
  launchWebScript,
  resolveDesktopDir,
  shortcutRefreshCommand,
  refreshDesktopShortcut,
  watchdogAlive,
  parseVersion,
  isNewerVersion,
  readInstalledDshVersion,
  queryNpmLatest,
  checkDshUpdate,
  detectPackageManager,
  runDshUpdate,
}
