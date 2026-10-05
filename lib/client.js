/**
 * dsh-netease-island — browser half (Apple "Dynamic Island" style).
 *
 * Injected into the DSH web UI by the host plugin. Renders a top-centre capsule
 * that stays collapsed while music plays and springs open on hover to reveal the
 * artwork, track metadata and transport controls.
 *
 * Everything lives inside a shadow root so DSH's own stylesheet can never reach
 * it (and vice versa). State is polled from /dsh-netease/state.json; the playback
 * position is then extrapolated locally against the animation clock so the
 * progress bar moves smoothly between polls instead of stepping.
 *
 * No frameworks, no build step, no external requests.
 */
;(function () {
  'use strict'

  if (window.__DSH_NETEASE_ISLAND__) return
  window.__DSH_NETEASE_ISLAND__ = true

  var BASE = '/dsh-netease'
  var POLL_MS = 700
  // The host publishes its effective interval in state.json, so the widget's
  // cadence follows the plugin config without editing this file.
  var pollMs = POLL_MS
  var POS_KEY = 'dsh-netease-island-pos'

  var root = null
  var els = {}
  var pollTimer = null
  var rafId = null
  var autoCollapseTimer = null

  var state = {
    active: false,
    playing: false,
    title: '',
    artist: '',
    album: '',
    durationSec: 0,
    rate: 1,
    canNext: false,
    canPrev: false,
    canSeek: false,
    coverSerial: 0,
    bridge: 'starting',
  }

  // Local playback clock: { positionSec, atMs, playing, rate }
  var anchor = null
  var hovered = false
  var expanded = false
  var seeking = false
  var dragging = false
  var dragMoved = false
  var dragStart = null
  var seenFirstState = false
  var lastTrackKey = null
  var lastCoverSerial = 0

  var CSS = `
    /* IMPORTANT: the element carrying visible/hidden/playing and the drag
       coordinates is the shadow HOST. A .root selector written *inside* a
       shadow tree can never match the host, so these rules must use :host.
       Positioning goes through custom properties because an inline opacity or
       transform declaration would outrank every stylesheet rule here. */
    :host { all: initial; }
    :host {
      /* A definite width is what makes left:50% + translateX(-50%) an exact
         centred placement: the -50% resolves against the host's own width.
         With width:auto the host did not pick up the island's shrink-to-fit
         size, and the expanded capsule landed right of centre. */
      width: 212px;
      position: fixed;
      top: var(--island-top, 10px);
      left: var(--island-left, 50%);
      transform: translateX(-50%);
      z-index: 2147483000;
      pointer-events: none;
      opacity: 0;
      transition: opacity .38s ease,
                  transform .5s cubic-bezier(.22,1,.36,1),
                  width .48s cubic-bezier(.22,1,.36,1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI",
                   "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    :host(.pinned) { transform: none; }
    /* 212px / 406px are the .island OUTER widths (210 + 2*1px border, and
       404 + 2*1px border), so the host box always matches the capsule. */
    :host(.expanded) { width: 406px; }
    :host(.visible) { opacity: 1; }
    :host(.hidden) { opacity: 0; transform: translateX(-50%) translateY(-140%); pointer-events: none; }

    /* ambient halo tinted by the current artwork */
    .glow {
      position: absolute;
      inset: -16px;
      border-radius: 999px;
      background-size: cover;
      background-position: center;
      filter: blur(24px) saturate(180%);
      opacity: 0;
      transition: opacity .6s ease;
      pointer-events: none;
      z-index: 0;
    }
    :host(.has-cover) .glow { opacity: .5; }

    .island {
      position: relative;
      z-index: 1;
      width: 210px;
      height: 38px;
      background: rgba(6,6,8,.94);
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 999px;
      box-shadow: 0 10px 34px rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.05) inset;
      overflow: hidden;
      pointer-events: auto;
      cursor: default;
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      transition: width .48s cubic-bezier(.22,1,.36,1),
                  height .48s cubic-bezier(.22,1,.36,1),
                  border-radius .48s cubic-bezier(.22,1,.36,1),
                  box-shadow .3s ease;
    }
    .island.expanded {
      width: 404px;
      height: 116px;
      border-radius: 30px;
      box-shadow: 0 18px 50px rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.07) inset;
    }
    .island.dragging { transition: none; }

    /* ---------- compact ---------- */
    .compact {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 15px;
      opacity: 1;
      transition: opacity .2s ease;
    }
    .island.expanded .compact { opacity: 0; pointer-events: none; }

    .eq { display: flex; align-items: flex-end; gap: 2.5px; height: 14px; flex: none; }
    .eq i {
      display: block;
      width: 2.5px;
      height: 4px;
      border-radius: 2px;
      background: linear-gradient(180deg, #FF6B81, #EC4141);
      animation: eq .95s ease-in-out infinite;
    }
    .eq i:nth-child(1) { animation-delay: -.75s; }
    .eq i:nth-child(2) { animation-delay: -.45s; }
    .eq i:nth-child(3) { animation-delay: -.95s; }
    .eq i:nth-child(4) { animation-delay: -.2s; }
    @keyframes eq {
      0%, 100% { height: 4px; }
      50%      { height: 14px; }
    }
    :host(:not(.playing)) .eq i { animation-play-state: paused; height: 5px; }

    .ctitle {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 12.5px;
      font-weight: 600;
      color: rgba(255,255,255,.94);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: .1px;
    }
    .cnote {
      flex: none;
      font-size: 11px;
      color: rgba(255,255,255,.5);
    }

    /* ---------- expanded ---------- */
    /* Scoped to a DESCENDANT of the capsule. The capsule itself carries the
       expanded STATE class, so a bare .expanded selector matched the island
       too and handed it this layer's opacity:0 + position:absolute - the
       expanded island was therefore invisible. */
    .island .expanded {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: 84px 1fr;
      gap: 13px;
      align-items: center;
      padding: 15px 18px 18px;
      box-sizing: border-box;
      opacity: 0;
      pointer-events: none;
      transition: opacity .2s ease;
    }
    .island.expanded .expanded {
      opacity: 1;
      pointer-events: auto;
      transition-delay: .1s;
    }

    .art {
      width: 84px;
      height: 84px;
      border-radius: 13px;
      overflow: hidden;
      background: rgba(255,255,255,.06);
      box-shadow: 0 6px 20px rgba(0,0,0,.5);
      flex: none;
    }
    .art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .art .ph {
      width: 100%; height: 100%;
      display: grid; place-items: center;
      color: rgba(255,255,255,.28);
      font-size: 26px;
    }

    .right { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .title {
      font-size: 14px;
      font-weight: 650;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: .1px;
    }
    .artist {
      font-size: 12px;
      color: rgba(255,255,255,.58);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: -4px;
    }

    .row { display: flex; align-items: center; gap: 9px; }
    .times {
      margin-left: auto;
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      color: rgba(255,255,255,.5);
      white-space: nowrap;
    }

    .btn {
      width: 30px; height: 30px;
      border: 0; padding: 0;
      border-radius: 50%;
      display: grid; place-items: center;
      background: rgba(255,255,255,.09);
      color: #fff;
      cursor: pointer;
      transition: background .18s ease, transform .12s ease, opacity .2s ease;
      -webkit-appearance: none;
      appearance: none;
    }
    .btn:hover { background: rgba(255,255,255,.19); }
    .btn:active { transform: scale(.88); }
    .btn[disabled] { opacity: .3; cursor: default; }
    .btn[disabled]:hover { background: rgba(255,255,255,.09); }
    .btn.primary {
      width: 38px; height: 38px;
      background: linear-gradient(135deg, #FF6B81, #EC4141);
      box-shadow: 0 4px 14px rgba(236,65,65,.42);
    }
    .btn.primary:hover { filter: brightness(1.08); }
    .btn svg { width: 15px; height: 15px; display: block; fill: currentColor; }
    .btn.primary svg { width: 17px; height: 17px; }

    /* ---------- progress ---------- */
    .prog {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 3px;
      background: rgba(255,255,255,.13);
      z-index: 2;
      pointer-events: auto;
      cursor: pointer;
    }
    .prog::before {
      content: '';
      position: absolute;
      left: 0; right: 0; top: -8px; bottom: 0;
    }
    .prog .fill {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 0%;
      background: linear-gradient(90deg, #EC4141, #FF7A9C);
      border-radius: 999px;
    }
    .island:not(.expanded) .prog { pointer-events: none; }
    .island.expanded .prog { height: 4px; }
  `

  var ICON = {
    prev: '<svg viewBox="0 0 24 24"><path d="M7.2 6h2.3v12H7.2zM19 6v12l-9-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M14.5 6h2.3v12h-2.3zM5 6v12l9-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M8.4 5.2h3.3v13.6H8.4zM12.3 5.2h3.3v13.6h-3.3z"/></svg>',
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0
    var total = Math.floor(sec)
    return Math.floor(total / 60) + ':' + pad2(total % 60)
  }

  // --------------------------------------------------------------- position --

  function currentPosition() {
    if (!anchor) return 0
    var pos = anchor.positionSec
    if (anchor.playing) {
      pos += ((Date.now() - anchor.atMs) / 1000) * (anchor.rate || 1)
    }
    var dur = state.durationSec || 0
    if (dur > 0) {
      if (pos > dur) pos = dur
    }
    return pos < 0 ? 0 : pos
  }

  function setAnchor(positionSec, playing) {
    anchor = {
      positionSec: positionSec,
      atMs: Date.now(),
      playing: playing,
      rate: state.rate || 1,
    }
  }

  // ------------------------------------------------------------------ render --

  function render() {
    if (!root) return

    var visible = state.active && state.bridge === 'up'
    root.classList.toggle('visible', visible)
    root.classList.toggle('hidden', !visible)
    root.classList.toggle('playing', !!state.playing)
    root.classList.toggle('has-cover', !!state.coverSerial)

    if (!visible) return

    // The host needs the class too: `:host(.expanded)` widens it so the
    // centred placement stays exact while the capsule grows.
    root.classList.toggle('expanded', expanded)
    els.island.classList.toggle('expanded', expanded)

    els.ctitle.textContent = state.title || '未知曲目'
    els.title.textContent = state.title || '未知曲目'
    els.artist.textContent = state.artist || '未知艺术家'
    els.cnote.textContent = state.playing ? '播放中' : '已暂停'

    els.btnToggle.innerHTML = state.playing ? ICON.pause : ICON.play
    els.btnToggle.title = state.playing ? '暂停' : '播放'
    els.btnPrev.disabled = !state.canPrev
    els.btnNext.disabled = !state.canNext

    if (state.coverSerial && state.coverSerial !== lastCoverSerial) {
      lastCoverSerial = state.coverSerial
      var url = BASE + '/cover.png?v=' + state.coverSerial
      els.art.innerHTML = ''
      var img = document.createElement('img')
      img.alt = ''
      img.src = url
      img.onerror = function () { els.art.innerHTML = '<div class="ph">♪</div>' }
      els.art.appendChild(img)
      els.glow.style.backgroundImage = 'url("' + url + '")'
    } else if (!state.coverSerial && lastCoverSerial) {
      lastCoverSerial = 0
      els.art.innerHTML = '<div class="ph">♪</div>'
      els.glow.style.backgroundImage = ''
    }

    updateProgress()
  }

  function updateProgress() {
    if (!root || !els.progFill) return
    var dur = state.durationSec || 0
    var pos = currentPosition()
    var pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0
    els.progFill.style.width = pct + '%'
    els.cur.textContent = fmtTime(pos)
    els.dur.textContent = dur > 0 ? fmtTime(dur) : '--:--'
    els.cprog.style.width = pct + '%'
  }

  function tick() {
    if (state.active && state.playing) updateProgress()
    rafId = requestAnimationFrame(tick)
  }

  // ------------------------------------------------------------------ expand --

  function setExpanded(next) {
    expanded = !!next
    if (autoCollapseTimer) {
      clearTimeout(autoCollapseTimer)
      autoCollapseTimer = null
    }
    render()
  }

  function scheduleAutoCollapse(ms) {
    if (autoCollapseTimer) clearTimeout(autoCollapseTimer)
    autoCollapseTimer = setTimeout(function () {
      autoCollapseTimer = null
      if (!hovered && !seeking && !dragging) setExpanded(false)
    }, ms)
  }

  // ---------------------------------------------------------------- commands --

  function send(cmd, pos) {
    var payload = { cmd: cmd }
    if (cmd === 'seek') payload.pos = pos
    try {
      fetch(BASE + '/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {})
    } catch (err) {}
  }

  function seekFromClientX(clientX) {
    var rect = els.prog.getBoundingClientRect()
    if (!rect.width) return
    var ratio = (clientX - rect.left) / rect.width
    ratio = Math.max(0, Math.min(1, ratio))
    var dur = state.durationSec || 0
    if (dur <= 0) return
    var pos = ratio * dur
    setAnchor(pos, state.playing)
    updateProgress()
    send('seek', pos)
  }

  // ------------------------------------------------------------------- state --

  function applyState(msg) {
    var wasActive = state.active
    var prevTrack = lastTrackKey
    var prevSerial = state.coverSerial

    state.active = !!msg.active
    state.playing = !!msg.playing
    state.title = String(msg.title || '')
    state.artist = String(msg.artist || '')
    state.album = String(msg.album || '')
    state.durationSec = Number(msg.durationSec) || 0
    state.rate = Number(msg.rate) || 1
    state.canNext = msg.canNext !== false
    state.canPrev = msg.canPrev !== false
    state.canSeek = msg.canSeek !== false
    state.bridge = String(msg.bridge || 'up')
    if (typeof msg.coverSerial === 'number') state.coverSerial = msg.coverSerial
    if (typeof msg.pollMs === 'number') adoptPollMs(msg.pollMs)

    var trackKey = state.title + '|' + state.artist + '|' + state.album

    // Re-anchor the local clock whenever the host reports a fresh timeline, but
    // never while the user is mid-seek (that would fight their drag).
    if (!seeking) {
      if (typeof msg.positionSec === 'number') {
        var drift = anchor ? Math.abs(currentPosition() - msg.positionSec) : Infinity
        // Only accept a timeline that disagrees with ours by more than the poll
        // interval, otherwise smooth local extrapolation beats the host's.
        if (drift > pollMs / 1000 + 0.35 || trackKey !== prevTrack || !state.playing) {
          setAnchor(msg.positionSec, state.playing)
        } else {
          anchor.playing = state.playing
          anchor.rate = state.rate
        }
      }
    }

    if (trackKey !== prevTrack || (prevSerial === 0 && state.coverSerial > 0)) {
      lastCoverSerial = 0 // force artwork refresh on track change
    }
    lastTrackKey = trackKey

    render()

    // Dynamic-Island flourish: pop open briefly when the track changes.
    if (seenFirstState && state.active && trackKey !== prevTrack && !hovered && !dragging) {
      setExpanded(true)
      scheduleAutoCollapse(2800)
    }
    if (!state.active && expanded && !hovered) setExpanded(false)
    if (!wasActive && state.active) lastCoverSerial = 0
    seenFirstState = true
  }

  var inFlight = false
  function poll() {
    if (inFlight) return
    inFlight = true
    try {
      fetch(BASE + '/state.json', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null })
        .then(function (msg) { if (msg) applyState(msg) })
        .catch(function () {})
        .then(function () { inFlight = false })
    } catch (err) {
      inFlight = false
    }
  }

  // The host owns the cadence (plugin config `pollMs`); adopt it when it changes
  // and restart the timer so a config edit takes effect without a page reload.
  function adoptPollMs(next) {
    var value = Math.min(5000, Math.max(200, Math.round(next)))
    if (!isFinite(value) || value === pollMs) return
    pollMs = value
    if (pollTimer) schedulePoll()
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(function () {
      if (document.hidden) return
      poll()
    }, pollMs)
  }

  // ------------------------------------------------------------------ layout --

  function loadPosition() {
    try {
      var raw = localStorage.getItem(POS_KEY)
      if (!raw) return null
      var pos = JSON.parse(raw)
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') return pos
    } catch (err) {}
    return null
  }

  function savePosition(pos) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch (err) {}
  }

  function applyPosition(pos) {
    if (!root) return
    if (!pos) {
      root.classList.remove('pinned')
      root.style.removeProperty('--island-left')
      root.style.removeProperty('--island-top')
      return
    }
    root.classList.add('pinned')
    root.style.setProperty('--island-left', pos.left + 'px')
    root.style.setProperty('--island-top', pos.top + 'px')
  }

  function onDragStart(event) {
    if (event.button !== 0) return
    var target = event.target
    if (target && target.closest && (target.closest('.btn') || target.closest('.prog'))) return
    var rect = root.getBoundingClientRect()
    dragStart = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
    dragging = true
    dragMoved = false
  }

  function onDragMove(event) {
    if (!dragging || !dragStart) return
    var dx = event.clientX - dragStart.x
    var dy = event.clientY - dragStart.y
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 5) return
    if (!dragMoved) {
      dragMoved = true
      els.island.classList.add('dragging')
    }
    var maxLeft = Math.max(4, window.innerWidth - root.offsetWidth - 4)
    var left = Math.max(4, Math.min(maxLeft, dragStart.left + dx))
    var top = Math.max(4, Math.min(window.innerHeight - root.offsetHeight - 4, dragStart.top + dy))
    root.classList.add('pinned')
    root.style.setProperty('--island-left', left + 'px')
    root.style.setProperty('--island-top', top + 'px')
  }

  function onDragEnd() {
    if (!dragging) return
    dragging = false
    els.island.classList.remove('dragging')
    if (dragMoved) {
      var rect = root.getBoundingClientRect()
      savePosition({ left: rect.left, top: rect.top })
    }
    dragStart = null
  }

  // -------------------------------------------------------------------- boot --

  function build() {
    root = document.createElement('div')
    root.className = 'root hidden'
    root.id = 'dsh-netease-island-root'
    // No inline position/opacity here on purpose: inline styles would beat the
    // :host rules in the shadow stylesheet. applyPosition() drives the
    // --island-left / --island-top custom properties instead.

    var shadow = root.attachShadow({ mode: 'open' })

    var style = document.createElement('style')
    style.textContent = CSS
    shadow.appendChild(style)

    var glow = document.createElement('div')
    glow.className = 'glow'
    shadow.appendChild(glow)
    els.glow = glow

    var island = document.createElement('div')
    island.className = 'island'
    shadow.appendChild(island)
    els.island = island

    // compact row
    var compact = document.createElement('div')
    compact.className = 'compact'
    var eq = document.createElement('div')
    eq.className = 'eq'
    for (var i = 0; i < 4; i++) eq.appendChild(document.createElement('i'))
    var ctitle = document.createElement('div')
    ctitle.className = 'ctitle'
    var cnote = document.createElement('div')
    cnote.className = 'cnote'
    compact.appendChild(eq)
    compact.appendChild(ctitle)
    compact.appendChild(cnote)
    island.appendChild(compact)
    els.ctitle = ctitle
    els.cnote = cnote

    // expanded row
    var expandedEl = document.createElement('div')
    expandedEl.className = 'expanded'

    var art = document.createElement('div')
    art.className = 'art'
    art.innerHTML = '<div class="ph">♪</div>'
    expandedEl.appendChild(art)
    els.art = art

    var right = document.createElement('div')
    right.className = 'right'

    var title = document.createElement('div')
    title.className = 'title'
    var artist = document.createElement('div')
    artist.className = 'artist'
    right.appendChild(title)
    right.appendChild(artist)
    els.title = title
    els.artist = artist

    var row = document.createElement('div')
    row.className = 'row'

    var btnPrev = document.createElement('button')
    btnPrev.className = 'btn'
    btnPrev.innerHTML = ICON.prev
    btnPrev.title = '上一首'
    btnPrev.setAttribute('aria-label', '上一首')

    var btnToggle = document.createElement('button')
    btnToggle.className = 'btn primary'
    btnToggle.innerHTML = ICON.play
    btnToggle.title = '播放/暂停'
    btnToggle.setAttribute('aria-label', '播放或暂停')

    var btnNext = document.createElement('button')
    btnNext.className = 'btn'
    btnNext.innerHTML = ICON.next
    btnNext.title = '下一首'
    btnNext.setAttribute('aria-label', '下一首')

    var times = document.createElement('div')
    times.className = 'times'
    var cur = document.createElement('span')
    var sep = document.createElement('span')
    sep.textContent = ' / '
    var dur = document.createElement('span')
    dur.textContent = '--:--'
    times.appendChild(cur)
    times.appendChild(sep)
    times.appendChild(dur)

    row.appendChild(btnPrev)
    row.appendChild(btnToggle)
    row.appendChild(btnNext)
    row.appendChild(times)
    right.appendChild(row)
    expandedEl.appendChild(right)
    island.appendChild(expandedEl)

    els.btnPrev = btnPrev
    els.btnToggle = btnToggle
    els.btnNext = btnNext
    els.cur = cur
    els.dur = dur

    // progress (shared by both states, pinned to the capsule's bottom edge)
    var prog = document.createElement('div')
    prog.className = 'prog'
    var cprog = document.createElement('div')
    cprog.className = 'fill'
    prog.appendChild(cprog)
    island.appendChild(prog)
    els.prog = prog
    els.progFill = cprog
    els.cprog = cprog

    document.body.appendChild(root)
    applyPosition(loadPosition())

    // ---- interactions ----
    btnToggle.addEventListener('click', function (e) {
      e.stopPropagation()
      state.playing = !state.playing
      setAnchor(currentPosition(), state.playing)
      render()
      send('toggle')
    })
    btnPrev.addEventListener('click', function (e) { e.stopPropagation(); send('prev') })
    btnNext.addEventListener('click', function (e) { e.stopPropagation(); send('next') })

    root.addEventListener('mouseenter', function () {
      hovered = true
      setExpanded(true)
    })
    root.addEventListener('mouseleave', function () {
      hovered = false
      if (!seeking) setExpanded(false)
    })

    // seeking
    prog.addEventListener('pointerdown', function (e) {
      if (!expanded || !island.classList.contains('expanded')) return
      e.stopPropagation()
      seeking = true
      try { prog.setPointerCapture(e.pointerId) } catch (err) {}
      seekFromClientX(e.clientX)
    })
    prog.addEventListener('pointermove', function (e) {
      if (!seeking) return
      e.stopPropagation()
      seekFromClientX(e.clientX)
    })
    prog.addEventListener('pointerup', function (e) {
      if (!seeking) return
      e.stopPropagation()
      seeking = false
      try { prog.releasePointerCapture(e.pointerId) } catch (err) {}
      if (!hovered) setExpanded(false)
    })

    // dragging
    island.addEventListener('pointerdown', onDragStart)
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
    island.addEventListener('dblclick', function () {
      try { localStorage.removeItem(POS_KEY) } catch (err) {}
      applyPosition(null)
    })

    // ---- polling ----
    poll()
    schedulePoll()
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll()
    })

    if (rafId === null) rafId = requestAnimationFrame(tick)
  }

  function boot() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot, { once: true })
      return
    }
    try {
      build()
    } catch (err) {
      try { console.warn('[dsh-netease-island] 挂件初始化失败：', err) } catch (e2) {}
    }
  }

  boot()
})()
