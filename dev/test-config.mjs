/**
 * Plugin-config contract test.
 *
 * README.md documents two config keys (`pollMs`, `appPatterns`), so this proves
 * that `apply(root, config)` really honours them, that the defaults are what the
 * README claims, and that the values the host publishes to the widget
 * (`state.json`) match. It calls the registered route handler directly with stub
 * req/res objects, so it needs no HTTP server and no child process.
 *
 * Run: node dev/test-config.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function ok(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : '  -> ' + detail))
  }
}

function makeRoot() {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex() {
      return () => {}
    },
  }
  const root = {
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    inject(deps, fn) {
      fn({ webServer })
      return () => {}
    },
  }
  return { root, routes }
}

async function readState(routes) {
  const route = routes.find((r) => r.path === '/dsh-netease/state.json')
  if (!route) return null
  const out = { status: 0, body: '' }
  const res = {
    writeHead(code) {
      out.status = code
    },
    end(chunk) {
      if (chunk) out.body += chunk.toString('utf8')
    },
  }
  const req = { method: 'GET', headers: { host: '127.0.0.1:19387' } }
  await route.handler(req, res)
  try {
    return Object.assign({ status: out.status }, JSON.parse(out.body))
  } catch (err) {
    return { status: out.status }
  }
}

const mod = (await import('file:///' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))).default

console.log('dsh-netease-island plugin config test')
console.log('package root: ' + ROOT)

// -- 1. configured values are honoured; non-ASCII patterns are dropped ----------
const a = makeRoot()
mod.apply(a.root, { pollMs: 900, appPatterns: 'CloudMusic.exe, netease, 网易云' })
const stateA = await readState(a.routes)
ok('state.json answers 200', stateA !== null && stateA.status === 200, stateA && stateA.status)
ok('state.json publishes the configured pollMs', stateA !== null && stateA.pollMs === 900, stateA && stateA.pollMs)
ok('state.json publishes the configured appPatterns',
  stateA !== null && Array.isArray(stateA.appPatterns) && stateA.appPatterns.join('|') === 'CloudMusic.exe|netease',
  stateA && JSON.stringify(stateA.appPatterns))
ok('non-ASCII patterns are dropped (console code page would mangle them)',
  stateA !== null && stateA.appPatterns.every((p) => /^[\x20-\x7e]+$/.test(p)))
ok('a comma-separated appPatterns string is accepted',
  stateA !== null && stateA.appPatterns.length === 2)

// -- 2. defaults when the profile supplies no config ---------------------------
const b = makeRoot()
mod.apply(b.root)
const stateB = await readState(b.routes)
ok('default pollMs is 500 (matches README)', stateB !== null && stateB.pollMs === 500, stateB && stateB.pollMs)
ok('default appPatterns are cloudmusic/netease/com.netease (matches README)',
  stateB !== null && stateB.appPatterns.join('|') === 'cloudmusic|netease|com.netease',
  stateB && JSON.stringify(stateB.appPatterns))

// -- 3. clamping and the array form -------------------------------------------
const c = makeRoot()
mod.apply(c.root, { pollMs: 50 })
const stateC = await readState(c.routes)
ok('pollMs below 200 is clamped up to 200', stateC !== null && stateC.pollMs === 200, stateC && stateC.pollMs)

const d = makeRoot()
mod.apply(d.root, { pollMs: 99999, appPatterns: ['CloudMusic.exe'] })
const stateD = await readState(d.routes)
ok('pollMs above 5000 is clamped down to 5000', stateD !== null && stateD.pollMs === 5000, stateD && stateD.pollMs)
ok('the array form of appPatterns is accepted',
  stateD !== null && stateD.appPatterns.join('|') === 'CloudMusic.exe',
  stateD && JSON.stringify(stateD.appPatterns))

// -- 4. garbage config must not throw -----------------------------------------
const e = makeRoot()
let threw = null
try {
  mod.apply(e.root, { pollMs: 'abc', appPatterns: 42 })
} catch (err) {
  threw = err
}
const stateE = await readState(e.routes)
ok('a garbage config is ignored instead of throwing', threw === null, threw && threw.message)
ok('a garbage config falls back to the defaults',
  stateE !== null && stateE.pollMs === 500 && stateE.appPatterns.join('|') === 'cloudmusic|netease|com.netease',
  stateE && JSON.stringify({ pollMs: stateE.pollMs, appPatterns: stateE.appPatterns }))

console.log('')
console.log(pass + ' checks, ' + fail + ' failure(s)')
// Exit explicitly: apply() starts a real bridge child (outside the sandbox), and
// its stdio pipes would otherwise keep this process alive with no output.
process.exit(fail === 0 ? 0 : 1)
