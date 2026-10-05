/**
 * Dev harness server (NOT shipped with the plugin).
 *
 * Two independent jobs:
 *
 *  1. SMTC test source — /smtc-test.html plays a near-silent <audio> element
 *     with MediaSession metadata. Any Chromium browser registering that session
 *     gives `lib/smtc-bridge.ps1` a real Windows SMTC session to read, so the
 *     bridge can be validated end-to-end (metadata, artwork, timeline, and the
 *     transport command round-trip) without needing NetEase Cloud Music running.
 *     The PCM is effectively silent so the test makes no noise.
 *
 *  2. Island UI harness — /harness.html loads the real lib/client.js against a
 *     mock /dsh-netease/* API, so the widget's appearance can be screenshotted
 *     without booting DSH. Add ?expanded=1 to force the hover state.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEV_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DEV_DIR, '..')
const PORT = Number(process.env.PORT || 8917)

// ------------------------------------------------------------ silent WAV -----
const SAMPLE_RATE = 8000
const SECONDS = 240
const TOTAL = SAMPLE_RATE * SECONDS

function makeWav() {
  const samples = TOTAL
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  // 1 LSB dither: inaudible, but genuinely non-silent so no browser decides the
  // element is idle and skips registering a media session.
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(i % 2 === 0 ? 1 : -1, 44 + i * 2)
  }
  return buf
}

const WAV = makeWav()

// ------------------------------------------------------------- mock state ----
const mock = {
  type: 'state',
  active: true,
  playing: true,
  title: '起风了（Cover 高橋優）- 完整版 Live',
  artist: '买辣椒也用券',
  album: '起风了',
  status: 'Playing',
  app: 'CloudMusic.exe',
  matched: true,
  sessionCount: 1,
  durationSec: 325,
  positionSec: 96,
  rate: 1,
  canNext: true,
  canPrev: true,
  canSeek: true,
  supported: true,
  bridge: 'up',
  detail: '',
  coverSerial: 1,
  atMs: Date.now(),
}

function mockSnapshot() {
  const elapsed = (Date.now() - mock.atMs) / 1000
  const pos = mock.playing ? Math.min(mock.durationSec, mock.positionSec + elapsed) : mock.positionSec
  return Object.assign({}, mock, {
    positionSec: Number(pos.toFixed(3)),
    atMs: Date.now(),
    status: mock.playing ? 'Playing' : 'Paused',
  })
}

function readArt() {
  try {
    return fs.readFileSync(path.join(DEV_DIR, 'art.png'))
  } catch (err) {
    return null
  }
}

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(buf.length),
  })
  res.end(buf)
}

function serveFile(res, file, type) {
  try {
    send(res, 200, fs.readFileSync(file), type)
  } catch (err) {
    send(res, 404, 'missing: ' + file)
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  if (p === '/smtc-test.html') return serveFile(res, path.join(DEV_DIR, 'smtc-test.html'), 'text/html; charset=utf-8')
  if (p === '/harness.html') return serveFile(res, path.join(DEV_DIR, 'harness.html'), 'text/html; charset=utf-8')
  if (p === '/art.png') return serveFile(res, path.join(DEV_DIR, 'art.png'), 'image/png')
  if (p === '/tone.wav') return send(res, 200, WAV, 'audio/wav')

  // --- the real widget, served exactly as the host plugin would serve it ---
  if (p === '/dsh-netease/widget.js') return serveFile(res, path.join(ROOT, 'lib', 'client.js'), 'application/javascript; charset=utf-8')

  if (p === '/dsh-netease/state.json') {
    return send(res, 200, JSON.stringify(mockSnapshot()), 'application/json; charset=utf-8')
  }

  if (p === '/dsh-netease/cover.png') {
    const art = readArt()
    if (!art) return send(res, 404, 'no art')
    return send(res, 200, art, 'image/png')
  }

  if (p === '/dsh-netease/command') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch (err) {}
      const now = mockSnapshot()
      mock.positionSec = now.positionSec
      mock.atMs = Date.now()
      if (payload.cmd === 'toggle') mock.playing = !mock.playing
      if (payload.cmd === 'play') mock.playing = true
      if (payload.cmd === 'pause') mock.playing = false
      if (payload.cmd === 'next') { mock.title = '下一首测试曲目'; mock.coverSerial += 1 }
      if (payload.cmd === 'prev') { mock.title = '上一首测试曲目'; mock.coverSerial += 1 }
      if (payload.cmd === 'seek') mock.positionSec = Number(payload.pos) || 0
      console.log('[harness] command', JSON.stringify(payload), '-> playing=' + mock.playing)
      send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8')
    })
    return
  }

  send(res, 404, 'not found: ' + p)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('harness listening on http://127.0.0.1:' + PORT)
  console.log('  SMTC test source : http://127.0.0.1:' + PORT + '/smtc-test.html')
  console.log('  island harness   : http://127.0.0.1:' + PORT + '/harness.html')
  console.log('  island expanded  : http://127.0.0.1:' + PORT + '/harness.html?expanded=1')
})
