/**
 * dsh-netease-island — host half.
 *
 * Exposes Windows' System Media Transport Controls (SMTC) session to the DSH web
 * UI and forwards transport commands back. All of the Windows-specific work
 * happens in `lib/smtc-bridge.ps1`, a persistent Windows PowerShell 5.1 child
 * process; this file is the process supervisor plus the HTTP surface.
 *
 * Why SMTC instead of the NetEase API: the desktop client publishes its playback
 * state to the OS (that is what makes the keyboard media keys work). Reading that
 * gives us title / artist / album / artwork / position / transport controls with
 * no network call, no login, no cookie, and no account access at all.
 *
 * Routes (all under /dsh-netease):
 *   GET  /state.json   latest snapshot + bridge health
 *   GET  /cover.png    current artwork (immutable, keyed by ?v=<serial>)
 *   GET  /widget.js    the browser half
 *   POST /command      {"cmd":"toggle"|"play"|"pause"|"next"|"prev"|"seek", "pos":<sec>}
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Boot trace. The host half can fail to mount SILENTLY: no route, no bridge, no
// error in any log — the widget simply never appears and nothing says why. Every
// mount attempt and its outcome is appended here (and echoed to stdout, which the
// desktop shell forwards) so that question is answerable after the fact.
const TRACE_FILE = path.join(
  process.env.DSH_HOME || path.join(process.env.USERPROFILE || '.', '.dsh'),
  'dsh-netease-island-boot.log',
)

function trace(message) {
  const line = new Date().toISOString() + ' [pid ' + String(process.pid) + '] ' + message + '\n'
  try { fs.appendFileSync(TRACE_FILE, line) } catch (err) {}
  try { console.log('[dsh-netease-island] ' + message) } catch (err) {}
}

trace('lib/index.js loaded')

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'smtc-bridge.ps1')
const CLIENT_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'client.js')

const ROUTE_BASE = '/dsh-netease'
const WIDGET_SRC = ROUTE_BASE + '/widget.js'
const IS_WINDOWS = process.platform === 'win32'
const DEFAULT_POLL_MS = 500
const DEFAULT_APP_PATTERNS = ['cloudmusic', 'netease', 'com.netease']

// Config is read from the profile's `cordis.patch.yml` entry (`config:`) and
// falls back to the defaults below. `appPatterns` is deliberately kept
// ASCII-only: the patterns travel to powershell.exe as a command-line argument,
// and a non-ASCII argument is mangled by the console code page before the
// bridge ever sees it (NetEase's own app id is ASCII, so this costs nothing).
const pluginConfig = { pollMs: DEFAULT_POLL_MS, appPatterns: DEFAULT_APP_PATTERNS.slice() }

function normalizeConfig(raw) {
  const config = { pollMs: DEFAULT_POLL_MS, appPatterns: DEFAULT_APP_PATTERNS.slice() }
  if (!raw || typeof raw !== 'object') return config

  const poll = Number(raw.pollMs)
  if (Number.isFinite(poll)) config.pollMs = Math.min(5000, Math.max(200, Math.round(poll)))

  const rawPatterns = Array.isArray(raw.appPatterns)
    ? raw.appPatterns
    : (typeof raw.appPatterns === 'string' ? raw.appPatterns.split(',') : null)
  if (rawPatterns) {
    const list = rawPatterns
      .map((value) => String(value == null ? '' : value).trim())
      .filter((value) => value !== '' && /^[\x20-\x7e]+$/.test(value))
    if (list.length) config.appPatterns = list
  }
  return config
}
const MAX_BODY_BYTES = 4096
const ALLOWED_COMMANDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'seek'])
const LOOPBACK_HOSTS = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|::1)$/

// Windows PowerShell 5.1 specifically: pwsh (7+) is .NET Core and cannot project
// the WinRT types the bridge needs. Prefer the absolute path so we never pick up
// a pwsh shim that happens to be earlier on PATH.
function resolvePowershell() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const absolute = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    if (fs.statSync(absolute).isFile()) return absolute
  } catch (err) {}
  return 'powershell.exe'
}

// ---------------------------------------------------------------- bridge I/O --

const bridge = {
  proc: null,
  ready: false,
  stopped: false,
  restarts: 0,
  timer: null,
  stderr: '',
  fatal: '',
  lastError: '',
  lastExit: null,
}

let latestState = { type: 'state', active: false }
let cover = null // { mime, bytes, serial }
let coverSerial = 0
let stdoutBuffer = ''

function bridgeHealth() {
  if (!IS_WINDOWS) return 'unsupported'
  if (bridge.fatal) return 'fatal'
  if (bridge.proc && bridge.ready) return 'up'
  if (bridge.proc) return 'starting'
  return 'down'
}

function bridgeDetail() {
  if (!IS_WINDOWS) return '仅支持 Windows（依赖系统 SMTC 媒体会话）'
  if (bridge.fatal) return bridge.fatal
  if (bridge.lastError) return bridge.lastError
  if (!bridge.proc && bridge.stderr) return bridge.stderr.slice(-400)
  return ''
}

function handleLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch (err) {
    return
  }
  if (!msg || typeof msg !== 'object') return

  switch (msg.type) {
    case 'state':
      latestState = msg
      bridge.ready = true
      break
    case 'ready':
      bridge.ready = true
      break
    case 'cover': {
      try {
        const bytes = Buffer.from(String(msg.dataBase64 || ''), 'base64')
        if (bytes.length > 0) {
          coverSerial += 1
          cover = { mime: String(msg.mime || 'image/jpeg'), bytes, serial: coverSerial }
        }
      } catch (err) {}
      break
    }
    case 'fatal':
      bridge.fatal = String(msg.message || 'SMTC 不可用')
      bridge.ready = false
      break
    case 'error':
      bridge.lastError = String(msg.message || '')
      break
    default:
      break
  }
}

function onStdout(chunk) {
  stdoutBuffer += chunk
  // A single cover line carries a base64 image, so the buffer can legitimately
  // grow large; only guard against a runaway producer with no newline at all.
  if (stdoutBuffer.length > 16 * 1024 * 1024) {
    stdoutBuffer = ''
    return
  }
  let index
  while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, index).trim()
    stdoutBuffer = stdoutBuffer.slice(index + 1)
    if (line) handleLine(line)
  }
}

function scheduleRestart() {
  if (bridge.stopped) return
  if (bridge.timer) clearTimeout(bridge.timer)
  bridge.restarts += 1
  const delay = Math.min(30000, 1000 * Math.pow(1.6, Math.min(bridge.restarts, 8)))
  bridge.timer = setTimeout(() => {
    bridge.timer = null
    startBridge()
  }, delay)
  if (bridge.timer && typeof bridge.timer.unref === 'function') bridge.timer.unref()
}

function startBridge() {
  if (!IS_WINDOWS || bridge.stopped || bridge.proc) return

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', BRIDGE_SCRIPT,
    '-PollMs', String(pluginConfig.pollMs),
    '-AppPattern', pluginConfig.appPatterns.join(','),
  ]

  let proc
  try {
    proc = spawn(resolvePowershell(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (err) {
    bridge.lastError = String((err && err.message) || err)
    scheduleRestart()
    return
  }

  bridge.proc = proc
  bridge.ready = false
  bridge.stderr = ''

  if (proc.stdout) {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', onStdout)
  }
  if (proc.stderr) {
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      bridge.stderr = (bridge.stderr + chunk).slice(-2000)
    })
  }
  proc.on('error', (err) => {
    bridge.lastError = String((err && err.message) || err)
  })
  proc.on('exit', (code) => {
    if (bridge.proc === proc) bridge.proc = null
    bridge.ready = false
    stdoutBuffer = ''
    if (!bridge.stopped) {
      bridge.lastExit = code
      scheduleRestart()
    }
  })
}

function stopBridge() {
  bridge.stopped = true
  if (bridge.timer) {
    clearTimeout(bridge.timer)
    bridge.timer = null
  }
  const proc = bridge.proc
  bridge.proc = null
  if (!proc) return
  try { proc.stdin.end() } catch (err) {}
  const killTimer = setTimeout(() => {
    try { proc.kill() } catch (err) {}
  }, 500)
  if (typeof killTimer.unref === 'function') killTimer.unref()
}

function sendCommand(cmd, pos) {
  const proc = bridge.proc
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false
  const payload = { cmd }
  if (cmd === 'seek') payload.pos = Number.isFinite(pos) ? pos : 0
  try {
    proc.stdin.write(JSON.stringify(payload) + '\n')
    return true
  } catch (err) {
    return false
  }
}

// -------------------------------------------------------------------- routes --

function sendJson(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function deny(res, code) {
  try {
    res.writeHead(code || 403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
  } catch (err) {}
}

/**
 * Lightweight trust fence, mirroring what dsh's own connection service does for
 * third-party routes: reject cross-site requests, reject an Origin that does not
 * match Host, and require loopback for anything that *does* something.
 *
 * Reads may be served to a non-loopback host (so the widget still renders when
 * DSH is reached over the LAN); transport commands may not, because they drive
 * an application on this machine.
 */
function fence(req, res, opts) {
  const headers = (req && req.headers) || {}
  const method = String((req && req.method) || 'GET').toUpperCase()

  let hostUrl
  try {
    hostUrl = new URL('http://' + String(headers.host || ''))
  } catch (err) {
    deny(res, 403)
    return false
  }

  const hostname = hostUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const loopback = LOOPBACK_HOSTS.test(hostname)

  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    deny(res, 403)
    return false
  }
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let originUrl = null
    try {
      originUrl = new URL(origin)
    } catch (err) {
      deny(res, 403)
      return false
    }
    if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
      deny(res, 403)
      return false
    }
  }
  if (opts && opts.requireLoopback && !loopback) {
    deny(res, 403)
    return false
  }
  return true
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Reject without killing the socket: destroying the request here would
        // turn an over-long body into a bare connection reset instead of a
        // readable 413. Drain what is still coming so the response can flush.
        settled = true
        const err = new Error('body too large')
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        try { req.resume() } catch (e) {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

let clientCache = { text: '', mtimeMs: 0 }
function loadClientScript() {
  try {
    const stat = fs.statSync(CLIENT_SCRIPT)
    if (clientCache.text && clientCache.mtimeMs === stat.mtimeMs) return clientCache.text
    const text = fs.readFileSync(CLIENT_SCRIPT, 'utf8')
    clientCache = { text, mtimeMs: stat.mtimeMs }
    return text
  } catch (err) {
    return clientCache.text || ''
  }
}

export default {
  name: 'dsh-netease-island',

  apply(root, config) {
    trace('apply() entered')
    // The cordis loader hands the bundle entry's `config:` to the plugin here.
    // `root.config` is only readable when the fiber declares `inject: ['config']`;
    // reading it unguarded throws `cannot get property "config" without inject` and
    // fails the whole entry, so probe it defensively (dev harnesses expose it).
    let fallbackConfig
    try {
      fallbackConfig = root && root.config
    } catch (err) {
      fallbackConfig = undefined
    }
    const effective = normalizeConfig(config || fallbackConfig)
    pluginConfig.pollMs = effective.pollMs
    pluginConfig.appPatterns = effective.appPatterns
    trace('config: pollMs=' + String(pluginConfig.pollMs) + ' appPatterns=' + pluginConfig.appPatterns.join('|'))

    const disposers = []
    try {
      root.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch (err) {}
        }
      })
    } catch (err) {
      trace('root.effect() threw: ' + (err && err.message))
    }

    // ① Desktop (Electron) injection. The desktop shell renders its index.html
    //    straight from the packaged static dist, so `tapIndex` never runs there.
    //    The only channel is the structured `webserver/index-inject` table, and
    //    the page-side interpreter treats a `script-src` row as fatal on load
    //    failure (a dead route would take the whole app's boot down with it).
    //    So push an inline row that creates the <script> itself and swallows
    //    onerror: if our route is gone, it fails silently instead of killing DSH.
    try {
      disposers.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === WIDGET_SRC) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_SRC) >= 0) return
          }
          table.push({
            kind: 'script',
            placement: 'body',
            text: '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
              + 'var s=document.createElement("script");s.src="' + WIDGET_SRC + '";'
              + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()',
          })
        } catch (err) {}
      }))
    } catch (err) {
      trace('root.on(webserver/index-inject) threw: ' + (err && err.message))
    }

    // ② HTTP surface, once the webserver is available.
    //
    // Waiting only on `root.inject` is not enough in every host: if that callback
    // never fires, the plugin registers no route and starts no bridge while
    // reporting nothing anywhere. So the mount is idempotent and is also attempted
    // immediately (the service may already exist) and once more on a short timer.
    let mounted = false

    function mountVia(ctx, how) {
      if (mounted) return
      if (!ctx || !ctx.webServer) {
        trace('mount via ' + how + ' skipped: webServer service unavailable')
        return
      }
      mounted = true
      trace('mounting HTTP surface via ' + how)

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_BASE + '/state.json',
        handler: (req, res) => {
          if (!fence(req, res)) return
          sendJson(res, Object.assign({}, latestState, {
            bridge: bridgeHealth(),
            detail: bridgeDetail(),
            supported: IS_WINDOWS,
            pollMs: pluginConfig.pollMs,
            appPatterns: pluginConfig.appPatterns,
            coverSerial: cover ? cover.serial : 0,
          }))
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_BASE + '/cover.png',
        handler: (req, res) => {
          if (!fence(req, res)) return
          if (!cover) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('no cover')
            return
          }
          res.writeHead(200, {
            'Content-Type': cover.mime,
            // The serial changes per track, so the bytes behind a given URL are
            // genuinely immutable — no re-download on every poll.
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': String(cover.bytes.length),
          })
          res.end(cover.bytes)
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: WIDGET_SRC,
        handler: (req, res) => {
          if (!fence(req, res)) return
          const body = Buffer.from(loadClientScript(), 'utf8')
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(body.length),
          })
          res.end(body)
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_BASE + '/command',
        handler: async (req, res) => {
          if (!fence(req, res, { requireLoopback: true })) return
          if (String(req.method || 'GET').toUpperCase() !== 'POST') {
            sendJson(res, { ok: false, error: 'method not allowed' }, 405)
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch (err) {
            const tooLarge = !!err && err.code === 'BODY_TOO_LARGE'
            sendJson(res, { ok: false, error: tooLarge ? 'body too large' : 'bad body' }, tooLarge ? 413 : 400)
            return
          }
          let payload
          try {
            payload = JSON.parse(body || '{}')
          } catch (err) {
            sendJson(res, { ok: false, error: 'bad json' }, 400)
            return
          }
          const cmd = String((payload && payload.cmd) || '')
          if (!ALLOWED_COMMANDS.has(cmd)) {
            sendJson(res, { ok: false, error: 'unknown command' }, 400)
            return
          }
          const pos = Number(payload && payload.pos)
          const sent = sendCommand(cmd, Number.isFinite(pos) ? pos : 0)
          sendJson(res, sent ? { ok: true } : { ok: false, error: 'bridge unavailable' }, sent ? 200 : 503)
        },
      }))

      // ③ Browser form of DSH: the host renders index.html itself, so tapping it
      //    is the simplest injection path. Both paths coexist and dedupe.
      try {
        if (typeof ctx.webServer.tapIndex === 'function') {
          disposers.push(ctx.webServer.tapIndex((html) => {
            if (typeof html !== 'string' || html.indexOf(WIDGET_SRC) !== -1) return html
            const tag = '<script defer src="' + WIDGET_SRC + '"></script>'
            if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
            return html + tag
          }))
        }
      } catch (err) {}

      startBridge()
      disposers.push(() => stopBridge())
      trace('HTTP surface mounted via ' + how + '; bridge pid ' + String(bridge.proc ? bridge.proc.pid : 'none'))

      if (!IS_WINDOWS) {
        try { console.warn('[dsh-netease-island] 非 Windows 平台：无法读取系统 SMTC 媒体会话，挂件将保持隐藏。') } catch (err) {}
      }
    }

    // The normal path: fires as soon as `webServer` is present.
    try {
      root.inject(['webServer'], (ctx) => mountVia(ctx, 'inject'))
    } catch (err) {
      trace('root.inject(webServer) threw: ' + (err && err.message))
    }
    // Already-present service (plugin loaded after the webserver settled).
    try {
      if (root.get('webServer') !== undefined) mountVia(root, 'root.get')
    } catch (err) {
      trace('root.get(webServer) threw: ' + (err && err.message))
    }
    // Last resort: never leave the plugin silently unmounted.
    const mountGuard = setTimeout(() => mountVia(root, 'timeout'), 3000)
    if (mountGuard && typeof mountGuard.unref === 'function') mountGuard.unref()
    disposers.push(() => clearTimeout(mountGuard))
  },
}
