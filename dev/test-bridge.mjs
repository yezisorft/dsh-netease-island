// dsh-netease-island — SMTC bridge integration test.
//
// Runs the real persistent PowerShell bridge as a child process and asserts the
// whole stdin/stdout protocol, including live playback control when a real
// Windows media session is available.
//
// Needs a shell that can give a Node child piped stdio (a normal desktop shell).
// Under a confined sandbox spawn() fails with EPERM; that is reported as SKIP.
//
// Usage: node dev/test-bridge.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'lib', 'smtc-bridge.ps1')
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

let checks = 0
let failures = 0
let skips = 0

function ok(label, condition, detail) {
  checks += 1
  if (condition) console.log('  PASS  ' + label)
  else { failures += 1; console.log('  FAIL  ' + label + (detail === undefined ? '' : '  -> ' + detail)) }
}
function skip(label, reason) { skips += 1; console.log('  SKIP  ' + label + '  -> ' + reason) }
function section(t) { console.log('\n' + t) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('dsh-netease-island SMTC bridge test')
console.log('bridge: ' + BRIDGE)
console.log('powershell: ' + PS)

// ------------------------------------------------------------------ harness --
class Bridge {
  constructor(child) {
    this.child = child
    this.lines = []
    this.raw = ''
    this.errors = []
    this.exited = null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      this.raw += chunk
      let i
      while ((i = this.raw.indexOf('\n')) !== -1) {
        const line = this.raw.slice(0, i).trim()
        this.raw = this.raw.slice(i + 1)
        if (!line) continue
        try { this.lines.push(JSON.parse(line)) }
        catch (err) { this.errors.push('unparsable stdout: ' + line.slice(0, 200)) }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => this.errors.push(String(chunk).trim().slice(0, 400)))
    child.on('exit', (code) => { this.exited = code })
    child.on('error', (err) => { this.errors.push('spawn error: ' + err.message) })
  }
  send(obj) { this.child.stdin.write(JSON.stringify(obj) + '\n') }
  /** All stdout objects of a type, oldest first. */
  of(type) { return this.lines.filter((l) => l.type === type) }
  last(type) { const a = this.of(type); return a.length ? a[a.length - 1] : undefined }
  /** Wait until predicate(parsed) holds for some already-received line. */
  async waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const l of this.lines) if (predicate(l)) return l
      if (this.exited !== null) return undefined
      await sleep(100)
    }
    return undefined
  }
  async waitState(predicate, timeoutMs) {
    return this.waitFor((l) => l.type === 'state' && predicate(l), timeoutMs)
  }
  /**
   * Like waitState, but ignores every line received before the call. Without
   * this a stale "Playing" line from before a control command satisfies the
   * assertion instantly and the test passes without proving anything.
   */
  async waitStateFresh(predicate, timeoutMs) {
    const from = this.lines.length
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (let i = from; i < this.lines.length; i += 1) {
        const l = this.lines[i]
        if (l.type === 'state' && predicate(l)) return l
      }
      if (this.exited !== null) return undefined
      await sleep(100)
    }
    return undefined
  }
  async waitAck(cmd, timeoutMs) {
    const from = this.lines.length
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (let i = from; i < this.lines.length; i += 1) {
        const l = this.lines[i]
        if (l.type === 'ack' && l.cmd === cmd) return l
      }
      if (this.exited !== null) return undefined
      await sleep(100)
    }
    return undefined
  }
}

// -------------------------------------------------------------------- spawn --
// Node throws synchronously from spawn() for a sandbox EPERM (it does not reach
// the child's 'error' event), so the guard has to wrap the call itself.
let child
try {
  child = spawn(PS, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE, '-PollMs', '400',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
} catch (err) {
  if (err && (err.code === 'EPERM' || /EPERM/.test(String(err.message)))) {
    console.log('\n  SKIP  every check: this shell cannot give a Node child piped stdio (spawn EPERM)')
    console.log('NOTE: sandbox confinement, not a plugin fault. Re-run from a normal shell for a real verdict.')
    process.exit(0)
  }
  throw err
}

const bridge = new Bridge(child)

section('1. startup + protocol')
const ready = await bridge.waitFor((l) => l.type === 'ready', 6000)
if (ready === undefined) {
  const spawnBlocked = bridge.errors.some((e) => /EPERM/.test(e))
  if (spawnBlocked) {
    skip('bridge child process starts and prints a ready line',
      'this shell cannot give a Node child piped stdio (' + bridge.errors.join(' | ') + ')')
    console.log('\n' + checks + ' checks, ' + failures + ' failure(s), ' + skips + ' skipped')
    console.log('NOTE: re-run with a normal (unconfined) shell for a real verdict.')
    process.exit(0)
  }
  ok('bridge child process starts and prints a ready line', false,
    'errors=' + bridge.errors.join(' | ').slice(0, 400))
} else {
  ok('bridge child process starts and prints a ready line', true)
  ok('ready line reports the poll cadence', ready.pollMs === 400, JSON.stringify(ready.pollMs))
  ok('ready line reports ASCII-only app patterns',
    Array.isArray(ready.patterns) && ready.patterns.every((p) => /^[\x20-\x7e]+$/.test(p)),
    JSON.stringify(ready.patterns))
  ok('app patterns cover the NetEase client app id', ready.patterns.includes('cloudmusic'), JSON.stringify(ready.patterns))
}

// The very first state line can be slow: a cold WinRT session makes
// TryGetMediaPropertiesAsync (and, for some players, GetTimelineProperties) take
// seconds before it answers. The budget is generous on purpose; the latency is
// reported so a regression is still visible.
const t0 = Date.now()
const firstState = await bridge.waitState(() => true, 25000)
console.log('  info  first state line after ' + (Date.now() - t0) + 'ms')
ok('a state line arrives', !!firstState)
if (firstState) {
  ok('state carries an atMs timestamp', typeof firstState.atMs === 'number' && firstState.atMs > 1e12, firstState.atMs)
  ok('state carries active as a boolean', typeof firstState.active === 'boolean', typeof firstState.active)
  ok('state carries sessionCount as a number', typeof firstState.sessionCount === 'number', typeof firstState.sessionCount)
}
ok('stdout is line-delimited JSON with no unparsable lines', bridge.errors.filter((e) => /unparsable/.test(e)).length === 0,
  bridge.errors.join(' | ').slice(0, 300))

section('2. unknown command is refused, not executed')
bridge.send({ cmd: 'definitely-not-a-command' })
const badAck = await bridge.waitAck('definitely-not-a-command', 5000)
ok('unknown command answered with an ack', !!badAck)
ok('unknown command ack is ok:false', !!(badAck && badAck.ok === false), badAck && JSON.stringify(badAck))

section('3. live session read + control')
const live = await bridge.waitState((l) => l.active === true, 4000)
if (!live) {
  skip('live playback read', 'no active Windows media session on this machine')
  skip('playback control', 'no active Windows media session on this machine')
} else {
  console.log('  info  session app=' + live.app)
  console.log('  info  title="' + live.title + '" artist="' + live.artist + '"')
  console.log('  info  status=' + live.status + ' pos=' + live.positionSec + 's dur=' + live.durationSec + 's')

  ok('live state reports a non-empty title', typeof live.title === 'string' && live.title.length > 0, JSON.stringify(live.title))
  ok('live state reports a playback status', typeof live.status === 'string' && live.status.length > 0, live.status)
  ok('live state reports a numeric duration', typeof live.durationSec === 'number' && live.durationSec >= 0, live.durationSec)
  // Edge's MediaSession bridge publishes a session but never a timeline
  // (durationSec stays 0), so plausibility only means something when the player
  // reports a duration at all.
  if (live.durationSec > 1) ok('duration is plausible for a real track', live.durationSec > 5, live.durationSec)
  else skip('duration plausibility', 'this session publishes no timeline (durationSec=0)')
  ok('live state reports the toggle capability', typeof live.canToggle === 'boolean', typeof live.canToggle)
  ok('live state reports the seek capability', typeof live.canSeek === 'boolean', typeof live.canSeek)

  // Does this source publish a position that actually advances? Only a source that
  // does can confirm a seek by readback, so measure it here instead of assuming -
  // otherwise a source with a frozen position would look like a broken plugin.
  let timelineMoves = false
  {
    const p1 = await bridge.waitStateFresh((l) => l.active === true, 4000)
    await sleep(2600)
    const p2 = await bridge.waitStateFresh((l) => l.active === true, 4000)
    if (p1 && p2 && p2.positionSec > p1.positionSec + 0.5) timelineMoves = true
    console.log('  info  timeline advances while playing: ' + timelineMoves +
      ' (' + (p1 && p1.positionSec) + 's -> ' + (p2 && p2.positionSec) + 's)')
  }

  const cover = await bridge.waitFor((l) => l.type === 'cover', 6000)
  if (cover) {
    ok('cover line uses an image mime type', /^image\//.test(String(cover.mime)), cover.mime)
    ok('cover line carries base64 artwork', typeof cover.dataBase64 === 'string' && cover.dataBase64.length > 64,
      cover.dataBase64 && cover.dataBase64.length)
  } else {
    skip('cover artwork extraction', 'this track reports no thumbnail')
  }

  // Establish a known baseline. A browser that RESTORED the test page registers a
  // media session that is already Paused, and then "pause changed the status"
  // fails for a reason that has nothing to do with the bridge. Force playback
  // first; if the source still will not play, report the transition checks as
  // unconfirmable rather than as failures.
  let controlBaseline = false
  {
    let current = await bridge.waitStateFresh((l) => l.active === true, 4000)
    if (current && current.status !== 'Playing') {
      bridge.send({ cmd: 'play' })
      await bridge.waitAck('play', 8000)
      current = await bridge.waitStateFresh((l) => l.active === true && l.status === 'Playing', 6000)
    }
    controlBaseline = !!(current && current.status === 'Playing')
    console.log('  info  control baseline playing=' + controlBaseline + ' status=' + (current && current.status))
  }

  // Control round-trips against the real session. Each assertion must see a line
  // produced AFTER its command, so a stale status cannot make it pass.
  const expectStatus = async (want, label) => {
    if (!controlBaseline) {
      skip(label, 'the source session is not playing, so a status transition cannot be observed')
      return
    }
    const seen = await bridge.waitStateFresh((l) => l.status === want, 8000)
    ok(label, !!seen, 'last status=' + (bridge.last('state') && bridge.last('state').status))
  }

  bridge.send({ cmd: 'pause' })
  const pauseAck = await bridge.waitAck('pause', 8000)
  ok('pause accepted', !!(pauseAck && pauseAck.ok === true), pauseAck && JSON.stringify(pauseAck))
  if (pauseAck) console.log('  info  pause via=' + pauseAck.via)
  await expectStatus('Paused', 'session actually reports Paused after pause')

  bridge.send({ cmd: 'play' })
  const playAck = await bridge.waitAck('play', 8000)
  ok('play accepted', !!(playAck && playAck.ok === true), playAck && JSON.stringify(playAck))
  if (playAck) console.log('  info  play via=' + playAck.via)
  await expectStatus('Playing', 'session actually reports Playing after play')

  bridge.send({ cmd: 'toggle' })
  const toggleAck = await bridge.waitAck('toggle', 8000)
  ok('toggle accepted', !!(toggleAck && toggleAck.ok === true), toggleAck && JSON.stringify(toggleAck))
  await expectStatus('Paused', 'toggle flipped Playing -> Paused')
  bridge.send({ cmd: 'toggle' })
  await bridge.waitAck('toggle', 8000)
  await expectStatus('Playing', 'second toggle flipped back to Playing')

  // A seek is only meaningful when the player publishes a timeline to seek on.
  if (live.canSeek && live.durationSec > 1) {
    bridge.send({ cmd: 'seek', pos: 42 })
    const seekAck = await bridge.waitAck('seek', 8000)
    ok('seek accepted', !!(seekAck && seekAck.ok === true), seekAck && JSON.stringify(seekAck))
    ok('seek ack echoes the requested position', !!seekAck && Math.abs(seekAck.pos - 42) < 0.001, seekAck && seekAck.pos)
    const near = await bridge.waitStateFresh((l) => l.positionSec >= 40 && l.positionSec <= 48, 8000)
    if (near) {
      ok('session position actually moved near 42s', true, near.positionSec)
    } else if (!timelineMoves) {
      // The OS accepted the request, but this source never reports a moving
      // position, so a readback can neither confirm nor refute it.
      skip('session position actually moved near 42s',
        'source accepts the seek but publishes a static position (unconfirmable by readback)')
    } else {
      ok('session position actually moved near 42s', false, bridge.last('state') && bridge.last('state').positionSec)
    }
  } else {
    skip('seek round-trip', 'this session publishes no timeline to seek within')
  }
}

section('4. clean shutdown on stdin close')
bridge.child.stdin.end()
const deadline = Date.now() + 8000
while (bridge.exited === null && Date.now() < deadline) await sleep(100)
ok('bridge exits when the host closes its stdin', bridge.exited !== null, 'exit=' + bridge.exited)
if (bridge.exited === null) { try { bridge.child.kill() } catch (e) {} }
const fatal = bridge.of('fatal')
ok('no fatal protocol line was emitted', fatal.length === 0, JSON.stringify(fatal[0] || null))

console.log('\n' + checks + ' checks, ' + failures + ' failure(s), ' + skips + ' skipped')
process.exit(failures === 0 ? 0 : 1)
