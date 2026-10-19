// Development-only check of the map zoom: the default per screen, the +/−
// buttons, the wheel (plain, Ctrl/⌘, a trackpad's stream) over the map only,
// the + - 0 keys (not while typing), a pinch on a phone, the overview (the
// whole office fitted and centered, beside the chat when it is open, held
// still while the avatar walks, following again on the way back in), the
// level surviving a reload, no CSP violations. Needs the server in guest
// mode serving the app build (npm run build), then:
//
//   node e2e/zoom.mjs [base URL, default http://localhost:8080] [screenshot dir]
//
// CHROME picks the browser binary and CDP_PORT the DevTools port.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { inflateSync } from 'node:zlib'

const base = process.argv[2] ?? 'http://localhost:8080'
const shots = process.argv[3] ?? mkdtempSync('/tmp/vbo-shots-')
const port = Number(process.env.CDP_PORT ?? 9335)
mkdirSync(shots, { recursive: true })

const run = Date.now().toString(36).slice(-5)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Longer than the zoom animation.
const SETTLE = 450

const profile = mkdtempSync('/tmp/vbo-')
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

class CDP {
  #id = 0
  #pending = new Map()
  #listeners = new Set()

  constructor(ws) {
    this.ws = ws
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method) {
        for (const fn of this.#listeners) fn(msg)
        return
      }
      const call = this.#pending.get(msg.id)
      if (!call) return
      this.#pending.delete(msg.id)
      if (msg.error) call.reject(new Error(msg.error.message))
      else call.resolve(msg.result)
    }
  }

  on(fn) {
    this.#listeners.add(fn)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id
    this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }
}

async function devtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      const { webSocketDebuggerUrl } = await res.json()
      const ws = new WebSocket(webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = reject
      })
      return new CDP(ws)
    } catch {
      await sleep(100)
    }
  }
  throw new Error('Chrome DevTools did not come up')
}

const KEYS = {
  '+': [187, 'Equal', 8],
  '=': [187, 'Equal', 0],
  '-': [189, 'Minus', 0],
  0: [48, 'Digit0', 0],
  Enter: [13, 'Enter', 0],
  Escape: [27, 'Escape', 0],
  ArrowLeft: [37, 'ArrowLeft', 0],
}

// Chrome's screenshots: 8-bit RGB or RGBA, not interlaced.
function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') [width, height, channels] = [data.readUInt32BE(0), data.readUInt32BE(4), data[9] === 6 ? 4 : 3]
    if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgb = Buffer.alloc(width * height * 3)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][filter]) & 255
    }
    for (let x = 0; x < width; x++) line.copy(rgb, (y * width + x) * 3, x * channels, x * channels + 3)
    prev = line
  }
  return { width, height, at: (x, y) => rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3) }
}

const differ = (p, q, by) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > by

/** Where the map is drawn: everything unlike the page's background in a corner. */
function mapBox(img) {
  const bg = img.at(1, 1)
  let [left, top, right, bottom] = [img.width, img.height, -1, -1]
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!differ(img.at(x, y), bg, 30)) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

/** The share of pixels of `b` that match `a` moved right by dx, outside `skip`. */
function matchShifted(a, b, dx, skip) {
  let same = 0
  let total = 0
  for (let y = 0; y < a.height; y += 3) {
    for (let x = Math.max(0, -dx); x < a.width - Math.max(0, dx); x += 3) {
      if (x + dx >= skip.left && x <= skip.right && y >= skip.top && y <= skip.bottom) continue
      total++
      if (!differ(a.at(x, y), b.at(x + dx, y), 24)) same++
    }
  }
  return same / total
}

const near = (a, b, by = 3) => Math.abs(a - b) <= by

async function open(cdp, name, [width, height], mobile = false) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const page = {
    name,
    errors: [],
    send,
    async eval(expression) {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) throw new Error(`${name}: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
      return res.result.value
    },
    async until(expression, timeout = 10_000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        try {
          const value = await page.eval(expression)
          if (value) return value
        } catch {
          // page still loading
        }
        await sleep(25)
      }
      throw new Error(`${name}: timed out waiting for ${expression}`)
    },
    async key(key) {
      const [code, physical, modifiers] = KEYS[key]
      const params = { key, code: physical, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers }
      const text = key.length === 1 ? { text: key } : key === 'Enter' ? { text: '\r' } : {}
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...text })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    },
    async click(id) {
      const { x, y } = await page.eval(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      if (mobile) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        return
      }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
    },
    async step(key) {
      const [code, physical] = KEYS[key]
      const params = { key, code: physical, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
      await sleep(60)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
      await sleep(300)
    },
    // Over the map unless told where; modifiers: 2 is Ctrl, 4 is ⌘.
    wheel(deltaY, modifiers = 0, at = { x: width / 3, y: height / 2 }) {
      return send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: 0, deltaY, modifiers })
    },
    center: (id) => page.eval(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`),
    rect: (id) => page.eval(`(() => { const { x, y, width, height } = document.getElementById('${id}').getBoundingClientRect(); return { x, y, width, height } })()`),
    // The map alone: everything else on the page hidden for the shot.
    async map() {
      const hide = (v) => page.eval(`(() => { for (const el of document.body.children) if (el.id !== 'game') el.style.visibility = '${v}'; return true })()`)
      await hide('hidden')
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      await hide('')
      return decodePng(Buffer.from(data, 'base64'))
    },
    // Where the map is once it stops moving.
    async box() {
      let last = null
      for (let i = 0; i < 10; i++) {
        const box = mapBox(await page.map())
        if (last && JSON.stringify(box) === JSON.stringify(last)) return box
        last = box
        await sleep(150)
      }
      return last
    },
    async pinch(from, to, steps = 8) {
      const cx = width / 2
      const cy = height / 2
      const points = (d) => [
        { x: cx - d / 2, y: cy, id: 1 },
        { x: cx + d / 2, y: cy, id: 2 },
      ]
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) })
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * i) / steps) })
        await sleep(16)
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    },
    async shot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(joinPath(shots, file), Buffer.from(data, 'base64'))
    },
    state: () =>
      page.eval(`(() => {
        const d = (id) => document.getElementById(id).getAttribute('aria-disabled') === 'true'
        const level = document.getElementById('zoom-level')
        return {
          level: level.hasAttribute('data-overview') ? 'overview' : level.textContent.trim(),
          inOff: d('zoom-in'), outOff: d('zoom-out'), resetOff: d('zoom-reset'),
          saved: localStorage.getItem('vb-office-32.zoom'),
          said: document.getElementById('zoom-status').textContent,
        }
      })()`),
  }
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Runtime.exceptionThrown') page.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    const { entry } = msg.params ?? {}
    if (msg.method === 'Log.entryAdded' && entry.level === 'error' && !/\/api\/session$|\/favicon\.ico$/.test(entry.url ?? '')) {
      page.errors.push(`${entry.text} ${entry.url ?? ''}`)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); window.addEventListener('wheel', (e) => { window.__wheel = e.defaultPrevented })`,
  })
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  return page
}

async function join(page, name) {
  await page.send('Page.navigate', { url: base })
  await page.until(`!document.getElementById('join').hidden`)
  await page.eval(`(() => { const i = document.getElementById('join-name'); i.value = ${JSON.stringify(name)}; document.getElementById('join-form').requestSubmit(); return true })()`)
  await page.until(
    `!document.getElementById('zoom').hidden && (document.getElementById('zoom-level-value').textContent !== '' || document.getElementById('zoom-level').hasAttribute('data-overview'))`,
  )
  await page.until(`document.getElementById('avatar-edit') && !document.getElementById('avatar-edit').disabled`)
  await sleep(600)
}

const results = { checks: [], shots }
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

// The overview of a 1280×800 view: 1600×800 at 0.77, centered.
const FIT_1280 = { left: 24, top: 92, width: 1232, height: 616 }

async function desktop(cdp) {
  const page = await open(cdp, 'desktop', [1280, 800])
  await join(page, `Zoom-${run}`)
  let s = await page.state()
  check('desktop starts at 3× by default', s.level === '3×' && s.saved === null && s.resetOff && !s.inOff && !s.outOff, s)
  await page.shot('desktop-3x-default.png')

  await page.click('zoom-in')
  await sleep(SETTLE)
  s = await page.state()
  check('+ goes to 4×, the limit, and is remembered', s.level === '4×' && s.inOff && !s.resetOff && s.saved === '4' && s.said === 'Zoom 4×', s)
  await page.click('zoom-in')
  await sleep(100)
  check('+ at the limit does nothing', (await page.state()).level === '4×')

  await page.click('zoom-out')
  await sleep(SETTLE)
  await page.key('-')
  await sleep(SETTLE)
  s = await page.state()
  check('− and the - key step out', s.level === '2×' && s.saved === '2', s)

  await page.wheel(100, 2)
  await sleep(SETTLE)
  s = await page.state()
  check('Ctrl+wheel down zooms out, with the default prevented', s.level === '1×' && !s.outOff && (await page.eval('window.__wheel')) === true, s)
  await page.wheel(100, 2)
  await sleep(SETTLE)
  s = await page.state()
  check('past 1× is the overview, the farthest level, remembered and announced', s.level === 'overview' && s.outOff && !s.inOff && s.saved === 'overview' && s.said === 'Visão geral do escritório', s)
  await page.wheel(-100, 4)
  await sleep(SETTLE)
  check('⌘+wheel up zooms in', (await page.state()).level === '1×')

  await page.wheel(-100)
  await sleep(SETTLE)
  s = await page.state()
  check('a plain wheel up over the map zooms in, with the default prevented', s.level === '2×' && (await page.eval('window.__wheel')) === true, s)
  await page.wheel(100)
  await sleep(SETTLE)
  await page.wheel(100)
  await sleep(SETTLE)
  check('a plain wheel down zooms out to the overview', (await page.state()).level === 'overview')
  // A trackpad: a long stream of small deltas, then its momentum.
  for (let i = 0; i < 40; i++) {
    await page.wheel(i < 25 ? -8 : -3)
    await sleep(16)
  }
  await sleep(SETTLE)
  check('a trackpad scroll takes one step, however long', (await page.state()).level === '1×')

  await page.wheel(-100, 0, await page.center('zoom'))
  await sleep(200)
  check('a wheel over the controls is left alone', (await page.state()).level === '1×' && (await page.eval('window.__wheel')) === false)
  const chatOpen = await page.eval(`!document.getElementById('chat-panel').hidden`)
  await page.wheel(100, 0, await page.center('chat-panel'))
  await sleep(200)
  check('a wheel over the chat scrolls it, not the map', chatOpen && (await page.state()).level === '1×' && (await page.eval('window.__wheel')) === false)

  // The chat, open by default here, covers the map's right; the overview
  // fits beside it.
  await page.key('-')
  await sleep(SETTLE)
  const panel = await page.rect('chat-panel')
  const free = panel.x
  const fit = Math.min((free - 2 * Math.min(24, free * 0.05)) / 1600, (800 - 80) / 800)
  let box = await page.box()
  check(
    'the overview fits beside the open chat',
    near(box.width, 1600 * fit) && near(box.left, (free - 1600 * fit) / 2) && near(box.top, (800 - 800 * fit) / 2),
    { box, fit, free },
  )
  await page.shot('desktop-overview-chat.png')
  await page.click('chat-close')
  await sleep(SETTLE + 200)
  box = await page.box()
  check('the overview fits the whole office on screen, centered', ['left', 'top', 'width', 'height'].every((k) => near(box[k], FIT_1280[k])), box)
  await page.shot('desktop-overview.png')

  // Walking in the overview leaves the office where it is.
  await page.step('ArrowLeft')
  const walked = await page.box()
  check('the overview holds still while the avatar walks', ['left', 'top', 'width', 'height'].every((k) => near(walked[k], box[k], 1)), walked)

  // Back in, the camera follows again: after one more step left (every
  // spawn has two free tiles to its left), everything but the avatar moves
  // one tile (64 px at 2×) to the right.
  await page.key('+')
  await sleep(SETTLE)
  await page.key('+')
  await sleep(SETTLE)
  const after = await page.map()
  await page.step('ArrowLeft')
  const later = await page.map()
  const avatar = { left: 640 - 160, right: 640 + 96, top: 400 - 120, bottom: 400 + 60 }
  const followed = matchShifted(after, later, 64, avatar)
  const still = matchShifted(after, later, 0, avatar)
  check('back from the overview the camera follows the avatar again', (await page.state()).level === '2×' && followed > 0.97 && still < 0.9, { followed, still })
  await page.shot('desktop-2x-following.png')

  await page.key('+')
  await sleep(SETTLE)
  await page.key('0')
  await sleep(SETTLE)
  s = await page.state()
  check('0 goes back to the default and forgets the pick', s.level === '3×' && s.saved === null && s.resetOff, s)

  for (let i = 0; i < 3; i++) {
    await page.key('-')
    await sleep(SETTLE)
  }
  s = await page.state()
  check('the - key reaches the overview', s.level === 'overview', s)
  await page.send('Page.reload')
  await page.until(`!document.getElementById('join').hidden`)
  await join(page, `Zoom-${run}`)
  s = await page.state()
  check('the overview survives a reload', s.level === 'overview' && s.saved === 'overview' && !s.resetOff, s)
  await page.click('chat-close')
  await sleep(SETTLE)
  box = await page.box()
  check('and fits as before', ['left', 'top', 'width', 'height'].every((k) => near(box[k], FIT_1280[k])), box)

  // Typing in the chat: the keys are text, not zoom.
  await page.key('Enter')
  await page.until(`document.activeElement?.id === 'chat-input'`)
  await page.key('-')
  await page.key('+')
  await page.key('0')
  await sleep(200)
  const typed = await page.eval(`document.getElementById('chat-input').value`)
  check('the keys type in the chat instead of zooming', (await page.state()).level === 'overview' && typed === '-+0', typed)
  await page.eval(`(() => { document.getElementById('chat-input').value = ''; document.activeElement.blur(); return true })()`)
  await page.key('Escape')
  await sleep(100)
  await page.click('chat-close')
  await sleep(SETTLE)

  // The avatar editor holds the keyboard too.
  await page.click('avatar-edit')
  await page.until(`document.getElementById('avatar-editor').open`)
  await page.key('+')
  await page.key('0')
  await sleep(200)
  check('the keys do nothing while the editor is open', (await page.state()).level === 'overview')
  await page.key('Escape')
  await page.until(`!document.getElementById('avatar-editor').open`)
  await page.eval('document.activeElement?.blur(), true')
  await page.key('+')
  await sleep(SETTLE)
  check('the keys work again once it closes', (await page.state()).level === '1×')

  // The overview refits to each window: a whole 1× where the office fits.
  await page.key('-')
  await sleep(SETTLE)
  const screens = {}
  for (const [w, h] of [
    [1920, 1080],
    [390, 844],
    [1280, 800],
  ]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(600)
    screens[`${w}×${h}`] = { ...(await page.box()), level: (await page.state()).level }
    if (w === 1920) await page.shot('desktop-1920-overview.png')
  }
  const wide = screens['1920×1080']
  const narrow = screens['390×844']
  check(
    'the overview refits to the window: 1× at 1920×1080, the fit on a phone',
    wide.level === 'overview' &&
      [wide.left, wide.top, wide.width, wide.height].every((v, i) => near(v, [160, 140, 1600, 800][i])) &&
      near(narrow.width, 351) &&
      near(narrow.left, 19.5) &&
      near(narrow.top, (844 - 175.5) / 2),
    screens,
  )

  // A pick holds across a resize within what the screen allows; the default follows.
  await page.key('0')
  await sleep(SETTLE)
  await page.key('+')
  await sleep(SETTLE)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  const phoneSized = await page.state()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  check('a pick of 4× shows as 3× on a phone-sized window and comes back', phoneSized.level === '3×' && (await page.state()).level === '4×', phoneSized)
  await page.key('0')
  await sleep(SETTLE)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  s = await page.state()
  check('the default follows the window: 4× at 1920×1080', s.level === '4×' && s.saved === null, s)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(500)

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await page.click('zoom-in')
  await sleep(60)
  check('reduced motion: the zoom lands at once', (await page.state()).level === '4×')
  await page.click('zoom-reset')
  await sleep(60)
  for (let i = 0; i < 3; i++) await page.click('zoom-out')
  await sleep(60)
  box = await page.box()
  check('reduced motion: the overview too', (await page.state()).level === 'overview' && ['left', 'top', 'width', 'height'].every((k) => near(box[k], FIT_1280[k])), box)
  await page.shot('desktop-overview-dark.png')
  await page.click('zoom-reset')
  await sleep(100)

  check('desktop: no CSP violations', (await page.eval('window.__csp.length')) === 0, await page.eval('window.__csp'))
  check('desktop: no errors', page.errors.length === 0, page.errors)
}

async function phone(cdp) {
  const page = await open(cdp, 'phone', [390, 844], true)
  await join(page, `Fone-${run}`)
  let s = await page.state()
  check('phone starts at 2× by default, 3× at most', s.level === '2×' && s.saved === null, s)
  await page.shot('phone-2x-default.png')

  await page.click('zoom-in')
  await sleep(SETTLE)
  s = await page.state()
  check('a tap on + goes to 3×, the phone limit', s.level === '3×' && s.inOff, s)
  await page.click('zoom-out')
  await sleep(SETTLE)
  await page.click('zoom-out')
  await sleep(SETTLE)
  s = await page.state()
  check('two taps on − go to 1×', s.level === '1×' && !s.outOff, s)
  await page.click('zoom-out')
  await sleep(SETTLE)
  s = await page.state()
  check('a third reaches the overview', s.level === 'overview' && s.outOff, s)
  const box = await page.box()
  check('the phone overview fits the office across the screen, centered', near(box.width, 351) && near(box.left, 19.5) && near(box.top, (844 - 175.5) / 2), box)
  await page.shot('phone-overview.png')

  await page.pinch(80, 240)
  await sleep(SETTLE)
  s = await page.state()
  check('a pinch out leaves the overview', s.level === '1×', s)
  await page.pinch(100, 260)
  await sleep(SETTLE)
  s = await page.state()
  check('a pinch out zooms in by its scale', s.level === '3×', s)
  await page.pinch(240, 150)
  await sleep(SETTLE)
  s = await page.state()
  check('a pinch in zooms out', s.level === '2×', s)
  await page.pinch(300, 50)
  await sleep(SETTLE)
  s = await page.state()
  check('a wide pinch in reaches the overview', s.level === 'overview' && s.saved === 'overview', s)
  const chatOpen = await page.eval(`!document.getElementById('chat-panel').hidden`)
  check('a pinch does not open anything', !chatOpen)

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(200)
  await page.shot('phone-overview-dark.png')

  check('phone: no CSP violations', (await page.eval('window.__csp.length')) === 0, await page.eval('window.__csp'))
  check('phone: no errors', page.errors.length === 0, page.errors)
}

let cdp
try {
  cdp = await devtools()
  await desktop(cdp)
  await phone(cdp)
} catch (err) {
  check('scenario ran to the end', false, String(err?.stack ?? err))
} finally {
  cdp?.ws.close()
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.checks.filter((c) => !c.ok)
console.log(JSON.stringify(results, null, 2))
console.log(failed.length ? `FAILED ${failed.length}/${results.checks.length}` : `OK ${results.checks.length} checks`)
process.exit(failed.length ? 1 : 0)
