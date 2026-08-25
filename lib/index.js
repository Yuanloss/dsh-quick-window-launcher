/**
 * dsh-quick-window-launcher — Host half.
 *
 * A fully generic desktop integration for the DeepSeek Harness web profile.
 * Nothing here hardcodes a machine user, a working directory, a Node binary,
 * or a dsh install path: every path is derived from the running host process
 * (process.execPath / process.argv / process.cwd) and the web server
 * (webServer.port). It therefore works for anyone who installs the plugin.
 *
 * What it does, at boot:
 *   1. Derives the runtime facts: node binary, dsh entry script + arg list,
 *      working directory, listening port, and the user's ~/.dsh/logs dir.
 *   2. Writes four helper PowerShell scripts into ~/.dsh/logs (the watchdog,
 *      the watchdog launcher, the desktop launcher, the shortcut creator) with
 *      those facts baked in, then:
 *        - starts the persistent restart watchdog (outside the process tree),
 *        - generates a desktop shortcut that opens the harness in its OWN
 *          standalone app-mode window (Chromium `--app=<url>`), not a browser
 *          tab — with a default-browser fallback when no Chromium is found.
 *   3. Registers two loopback-only HTTP routes on the web server:
 *        POST /api/shutdown  — graceful stop (SIGTERM -> dispose -> flush -> exit)
 *        POST /api/restart   — graceful stop, then a fresh instance via watchdog
 *   4. Registers a model-facing tool `open_web` that opens a URL in the system
 *      default browser's new tab.
 *
 * Restart keeps the same architecture as before: the graceful shutdown child
 * processes get cleaned up by the harness, so the actual relaunch must be
 * driven by a watchdog running OUTSIDE the host process tree. The plugin
 * writes the watchdog script at boot (when the host is stable) and launches it
 * detached; /api/restart only drops a request file and lets the watchdog do
 * the real restart after this process exits.
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

/**
 * Quote a value for embedding inside a single-quoted PowerShell literal.
 * @param {string} value - the raw value.
 * @returns {string} a PowerShell single-quoted string literal.
 */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * Build a PowerShell array literal for the boot arguments, e.g. @('web') or
 * @('--profile','web').
 * @param {string[]} args - the boot arguments to relaunch.
 * @returns {string} a PowerShell array literal.
 */
function psArray(args) {
  return '@(' + args.map((a) => psQuote(a)).join(',') + ')'
}

/** A single-quoted PowerShell array element (for a string[] literal line). */
function psArgList(args) {
  return '@(' + args.map((a) => psQuote(a)).join(',') + ')'
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

/** Open a URL in the system default browser (new tab). */
function openOnPlatform(url) {
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let cmd
    let args
    if (platform === 'win32') {
      cmd = 'powershell.exe'
      args = ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process ' + psQuote(url)]
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
    // Start-Process returns immediately; the browser owns the new tab.
    child.on('close', () => { if (!settled) { settled = true; resolve() } })
  })
}

/**
 * The persistent restart watchdog. Runs OUTSIDE the host process tree (started
 * via a detached launcher) and survives host shutdowns. ASCII-only body, written
 * with a UTF-8 BOM (Windows PowerShell 5.1 mis-parses without it).
 * @param {object} r - runtime facts.
 * @returns {string} the watchdog script body.
 */
function watchdogScript(r) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$port = ${r.port}`,
    `$node = ${psQuote(r.node)}`,
    `$entry = ${psQuote(r.entry)}`,
    `$launchArgs = ${psArgList(r.args)}`,
    `$workdir = ${psQuote(r.workdir)}`,
    `$logDir = ${psQuote(r.logsDir)}`,
    `$reqFile = Join-Path $logDir 'dsh-restart-request.json'`,
    `$procFile = Join-Path $logDir 'dsh-restart-processing.json'`,
    `$pidFile = Join-Path $logDir 'dsh-restart-watchdog.pid'`,
    `$trace = Join-Path $logDir 'dsh-restart-watchdog.log'`,
    `$graceSec = ${OLD_PROCESS_GRACE_SECONDS}`,
    'function Trace($msg) { Add-Content -Path $trace -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $msg) }',
    'function Test-PortOpen {',
    '  try {',
    '    $c = New-Object System.Net.Sockets.TcpClient',
    '    $c.Connect("127.0.0.1", $port)',
    '    $c.Close()',
    '    return $true',
    '  } catch { return $false }',
    '}',
    '$argList = @("`"$entry`"")',
    'foreach ($a in $launchArgs) { $argList += ("`"$a`"") }',
    'Set-Content -Path $pidFile -Value $PID',
    'Trace("watchdog loop started (pid " + $PID + "); waiting for restart requests")',
    'while ($true) {',
    '  if (Test-Path $reqFile) {',
    '    try {',
    '      Move-Item -Path $reqFile -Destination $procFile -Force -ErrorAction Stop',
    '    } catch {',
    '      Start-Sleep -Milliseconds 500',
    '      continue',
    '    }',
    '    $oldPid = 0',
    '    try { $oldPid = [int]((Get-Content $procFile -Raw | ConvertFrom-Json).oldPid) } catch {}',
    '    Trace("restart requested; old pid=" + $oldPid + "; waiting up to " + $graceSec + " s for it to exit")',
    '    $deadline = (Get-Date).AddSeconds($graceSec)',
    '    while ((Get-Date) -lt $deadline) {',
    '      $oldAlive = [bool](Get-Process -Id $oldPid -ErrorAction SilentlyContinue)',
    '      if (-not $oldAlive) { break }',
    '      Start-Sleep -Milliseconds 1000',
    '    }',
    '    $oldAlive = [bool](Get-Process -Id $oldPid -ErrorAction SilentlyContinue)',
    '    if ($oldAlive) {',
    '      Trace("old process still alive after " + $graceSec + " s; force-killing")',
    '      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue',
    '      Start-Sleep -Seconds 2',
    '    } else {',
    '      Trace("old process exited")',
    '    }',
    '    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    $stale = $false',
    '    if ($conn) {',
    '      $owner = $conn.OwningProcess',
    '      if ($owner -eq $oldPid) {',
    '        Trace("old pid " + $oldPid + " still owns the port; force-killing")',
    '        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue',
    '        Start-Sleep -Seconds 2',
    '      } else {',
    '        Trace("stale request: port " + $port + " now owned by pid " + $owner + "; aborting")',
    '        $stale = $true',
    '      }',
    '    }',
    '    if (-not $stale) {',
    '      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"',
    '      $outLog = Join-Path $logDir ("dsh-web-" + $stamp + ".out.log")',
    '      $errLog = Join-Path $logDir ("dsh-web-" + $stamp + ".err.log")',
    '      Trace("starting fresh instance")',
    '      for ($attempt = 0; $attempt -lt 3; $attempt++) {',
    '        $p = Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $workdir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -ErrorAction SilentlyContinue',
    '        if ($p) { Trace("started fresh instance pid " + $p.Id); break }',
    '        Trace("Start-Process attempt " + $attempt + " failed; retrying")',
    '        Start-Sleep -Seconds 3',
    '      }',
    '    }',
    '    Remove-Item $procFile -ErrorAction SilentlyContinue',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
  ].join('\n')
}

/**
 * The watchdog launcher: starts the watchdog OUTSIDE this process tree via the
 * shell (WScript.Shell.Run), deduplicating on the watchdog pid file.
 * @param {object} r - runtime facts.
 * @returns {string} the launcher script body.
 */
function watchdogLauncherScript(r) {
  const watchPath = join(r.logsDir, 'dsh-restart-watchdog.ps1')
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$pidFile = Join-Path ${psQuote(r.logsDir)} 'dsh-restart-watchdog.pid'`,
    `$watch = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${watchPath}"'`,
    '$existing = 0',
    'try { $existing = [int](Get-Content $pidFile -Raw -ErrorAction Stop) } catch {}',
    '$alive = $false',
    'if ($existing -gt 0) { $alive = [bool](Get-Process -Id $existing -ErrorAction SilentlyContinue) }',
    'if (-not $alive) {',
    '  (New-Object -ComObject WScript.Shell).Run($watch, 0, $false)',
    '}',
  ].join('\n')
}

/**
 * The desktop launcher: start the harness if it is not already running, then
 * open its UI in a STANDALONE app-mode window (Chromium/Edge `--app=<url>`),
 * falling back to the system default browser only when no Chromium is found.
 * @param {object} r - runtime facts.
 * @returns {string} the launcher script body.
 */
function launchWebScript(r) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$node = ${psQuote(r.node)}`,
    `$entry = ${psQuote(r.entry)}`,
    `$launchArgs = ${psArgList(r.args)}`,
    `$workdir = ${psQuote(r.workdir)}`,
    `$port = ${r.port}`,
    `$url = "http://127.0.0.1:" + $port`,
    `$logDir = ${psQuote(r.logsDir)}`,
    `$outLog = Join-Path $logDir 'dsh-web.out.log'`,
    `$errLog = Join-Path $logDir 'dsh-web.err.log'`,
    '$argList = @("`"$entry`"")',
    'foreach ($a in $launchArgs) { $argList += ("`"$a`"") }',
    '$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue',
    'if (-not $listening) {',
    '  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }',
    '  Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $workdir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog',
    '  for ($i = 0; $i -lt 60; $i++) {',
    '    Start-Sleep -Seconds 1',
    '    try {',
    '      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2',
    '      if ($resp.StatusCode -eq 200) { break }',
    '    } catch { }',
    '  }',
    '}',
    // Standalone app window: prefer a Chromium browser in `--app` mode.
    '$pf = $env:ProgramFiles',
    '$pf86 = ${env:ProgramFiles(x86)}',
    '$local = $env:LocalAppData',
    '$candidates = @(',
    '  "$pf\\Google\\Chrome\\Application\\chrome.exe",',
    '  "$pf86\\Google\\Chrome\\Application\\chrome.exe",',
    '  "$local\\Google\\Chrome\\Application\\chrome.exe",',
    '  "$pf\\Microsoft\\Edge\\Application\\msedge.exe",',
    '  "$pf86\\Microsoft\\Edge\\Application\\msedge.exe"',
    ')',
    '$browser = $null',
    'foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $browser = $c; break } }',
    'if ($browser) {',
    '  Start-Process -FilePath $browser -ArgumentList ("--app=" + $url)',
    '} else {',
    '  Start-Process $url',
    '}',
  ].join('\n')
}

/**
 * Create (or refresh) the desktop shortcut that launches the harness. Always
 * rewrites the shortcut so it points at the plugin's own generic launcher
 * (app-mode window), taking over any stale shortcut left by an older setup.
 * @param {object} r - runtime facts.
 * @param {string} launcherPath - absolute path to the launcher script.
 * @param {string} iconPath - absolute path to the bundled .ico (may be empty).
 * @param {string} desktopName - base file name of the shortcut.
 * @returns {string} the shortcut-creation script body.
 */
function ensureShortcutScript(r, launcherPath, iconPath, desktopName) {
  const lines = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$launcher = ${psQuote(launcherPath)}`,
    `$desktop = [Environment]::GetFolderPath('Desktop')`,
    `$lnk = Join-Path $desktop ${psQuote(desktopName + '.lnk')}`,
    "$pwsh = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '$sh = New-Object -ComObject WScript.Shell',
    '$sc = $sh.CreateShortcut($lnk)',
    '$sc.TargetPath = $pwsh',
    '$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""',
    '$sc.WorkingDirectory = (Split-Path $launcher -Parent)',
  ]
  if (iconPath) {
    lines.push(`$icon = ${psQuote(iconPath)}`)
    lines.push('if (Test-Path $icon) { $sc.IconLocation = "`"$icon`",0" }')
  }
  lines.push(`$sc.Description = ${psQuote(desktopName)}`)
  lines.push('$sc.Save()')
  return lines.join('\n')
}

/**
 * Write the four helper scripts into the logs dir and, when asked, generate the
 * desktop shortcut. Also starts the watchdog (detached) so /api/restart has a
 * live consumer later. Called from apply at boot, when the host is stable.
 * @param {object} ctx - the Cordis context.
 * @param {object} r - runtime facts.
 * @param {object} cfg - plugin config.
 */
function bootstrapScripts(ctx, r, cfg) {
  try {
    if (!existsSync(r.logsDir)) mkdirSync(r.logsDir, { recursive: true })
    const watchPath = join(r.logsDir, 'dsh-restart-watchdog.ps1')
    const watchLaunchPath = join(r.logsDir, 'dsh-restart-watchdog-launch.ps1')
    const launchPath = join(r.logsDir, 'dsh-launch-web.ps1')
    const shortcutPath = join(r.logsDir, 'dsh-ensure-desktop-shortcut.ps1')

    writeFileSync(watchPath, '\uFEFF' + watchdogScript(r), 'utf8')
    writeFileSync(watchLaunchPath, '\uFEFF' + watchdogLauncherScript(r), 'utf8')
    writeFileSync(launchPath, '\uFEFF' + launchWebScript(r), 'utf8')

    // Start the restart watchdog (outside the process tree). If the watchdog is
    // already running, the launcher is a no-op.
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', watchLaunchPath], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()

    // Generate the desktop shortcut (create it only if it does not yet exist,
    // so a user's own shortcut is never overwritten).
    if (cfg.createShortcut !== false) {
      const iconPath = resolveBundledIcon()
      writeFileSync(shortcutPath, '\uFEFF' + ensureShortcutScript(r, launchPath, iconPath, cfg.desktopName), 'utf8')
      const sc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shortcutPath], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      sc.unref()
    }
  } catch (e) {
    ctx?.logger?.error?.(PLUGIN_NAME + ': bootstrap failed: ' + String((e && e.message) || e))
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

    bootstrapScripts(ctx, r, cfg)

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
        writeFileSync(join(r.logsDir, 'dsh-restart-request.json'), JSON.stringify({ oldPid: process.pid, ts: Date.now() }))
        writeJson(res, 200, { ok: true, value: { restarting: true } })
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
export { deriveRuntime, watchdogScript, watchdogLauncherScript, launchWebScript, ensureShortcutScript, psQuote, psArray, psArgList, parseVersion, isNewerVersion, readInstalledDshVersion, queryNpmLatest, checkDshUpdate }
