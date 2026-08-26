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
 *   - shortcut creation/refresh is a ONE-SHOT inline powershell command
 *     (WScript.Shell COM) with no script file dropped on disk,
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

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
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
 * Quote a value for embedding inside a single-quoted PowerShell literal.
 * Only used for the one-shot shortcut-refresh command (never a script file).
 * @param {string} value - the raw value.
 * @returns {string} a PowerShell single-quoted string literal.
 */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
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
  try { fs.renameSync(reqPath, procPath) } catch { return }
  busy = true
  let oldPid = 0
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
}, 1000)
`
}

/**
 * The app-window launcher as PURE NODE (a generated .cjs run directly by
 * node.exe — this is what the desktop shortcut targets). Starts the harness
 * if it is not listening yet, then opens the UI in a standalone Chromium
 * app-mode window (--app=), falling back to the system default browser.
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

async function main() {
  if (!(await portOpen())) {
    const out = fs.openSync(path.join(CFG.logDir, 'dsh-web.out.log'), 'a')
    const err = fs.openSync(path.join(CFG.logDir, 'dsh-web.err.log'), 'a')
    const child = spawn(CFG.node, [CFG.entry].concat(CFG.args, ['--no-open']), {
      cwd: CFG.workdir, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    })
    child.unref()
    for (let i = 0; i < 60; i++) {
      await sleep(1000)
      if (await httpReady()) break
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
    } else {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true }).unref()
    }
  } else if (CFG.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore' }).unref()
  }
}

main().catch(() => {})
`
}

/**
 * Build the ONE-SHOT inline command that creates/refreshes the desktop
 * shortcut. No script file is ever written to disk (antivirus products
 * quarantine new .ps1 files on sight); the shortcut itself targets node.exe
 * running the generated launcher, so nothing on the desktop references
 * PowerShell either.
 * @param {object} r - runtime facts.
 * @param {string} launcherPath - absolute path to the launcher .cjs.
 * @param {string} iconPath - absolute path to the bundled .ico (may be empty).
 * @param {string} desktopName - base file name of the shortcut.
 * @returns {{cmd:string,args:string[]}} spawn target for the refresh.
 */
function shortcutRefreshCommand(r, launcherPath, iconPath, desktopName) {
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
    // Resolve the real Desktop (OneDrive redirections can be slow at boot).
    `$d=''`,
    `for($i=0;$i -lt 6 -and -not $d;$i++){$d=[Environment]::GetFolderPath('Desktop');if(-not $d){Start-Sleep -Seconds 2}}`,
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
  // NOT spawned with detached:true: powershell.exe silently exits (code 0,
  // nothing executed) under DETACHED_PROCESS on Windows. windowsHide plus
  // -WindowStyle Hidden keep it invisible instead.
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps] }
}

/**
 * Write the helper .cjs scripts into the logs dir, start the detached node
 * watchdog, and refresh the desktop shortcut via a one-shot inline command.
 * Called from apply at boot, when the host is stable.
 * @param {object} ctx - the Cordis context.
 * @param {object} r - runtime facts.
 * @param {object} cfg - plugin config.
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
    // app-window launcher. One-shot inline command; failures are logged by
    // the command itself into dsh-shortcut.log.
    if (cfg.createShortcut !== false) {
      const iconPath = resolveBundledIcon()
      const { cmd, args } = shortcutRefreshCommand(r, launchPath, iconPath, desktopName)
      // No detached:true here — see shortcutRefreshCommand: powershell.exe
      // dies instantly under DETACHED_PROCESS. windowsHide keeps it invisible.
      const sc = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
      sc.unref()
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

export default {
  inject: ['webServer'],
  apply(ctx, config) {
    const webServer = ctx.webServer
    const cfg = config || {}
    const desktopName = (typeof cfg.desktopName === 'string' && cfg.desktopName.length > 0) ? cfg.desktopName : DEFAULT_DESKTOP_NAME
    const r = deriveRuntime(webServer)

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

    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/shutdown', handler: shutdownHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/restart', handler: restartHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/dsh-update-check', handler: dshUpdateHandler }))
  },
}

// Exported so the generated scripts can be inspected/tested; not used by the
// loader at runtime.
export {
  deriveRuntime,
  watchdogScript,
  launchWebScript,
  shortcutRefreshCommand,
  watchdogAlive,
  psQuote,
  parseVersion,
  isNewerVersion,
  readInstalledDshVersion,
  queryNpmLatest,
  checkDshUpdate,
}
