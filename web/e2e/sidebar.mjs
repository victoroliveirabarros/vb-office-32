// Development-only check of the sidebar (phase 6.4): expanding, collapsing
// and remembering it; each panel (chat, people, rooms, settings); a direct
// message from the people list; "Ver no mapa" and the rooms' overview with
// the mark on the map; the theme; devices with media on; the drawer on a
// phone with focus held in it; the keyboard (Alt+1…5, Esc, fields holding
// the game's keys); no CSP violations; screenshots of every panel, light
// and dark, expanded and collapsed, at 1280×800, 1920×1080 and 390×844.
// Needs the server in guest mode serving the app build (npm run build),
// with LiveKit for the device checks (they are skipped without media), then:
//
//   node e2e/sidebar.mjs [base URL, default http://localhost:8080] [screenshot dir]
//
// CHROME picks the browser binary and CDP_PORT the DevTools port. Chrome's
// fake devices stand in for the microphone and the camera.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { inflateSync } from 'node:zlib'

const base = process.argv[2] ?? 'http://localhost:8080'
const shots = process.argv[3] ?? mkdtempSync('/tmp/vbo-shots-')
const port = Number(process.env.CDP_PORT ?? 9336)
mkdirSync(shots, { recursive: true })

const run = Date.now().toString(36).slice(-5)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Longer than the zoom and the sidebar's slide.
const SETTLE = 450

const profile = mkdtempSync('/tmp/vbo-')
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
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

// key: [keyCode, code, text]
const KEYS = {
  Enter: [13, 'Enter', '\r'],
  Escape: [27, 'Escape', ''],
  Tab: [9, 'Tab', ''],
  ArrowLeft: [37, 'ArrowLeft', ''],
  ArrowDown: [40, 'ArrowDown', ''],
  1: [49, 'Digit1', '1'],
  2: [50, 'Digit2', '2'],
  3: [51, 'Digit3', '3'],
  4: [52, 'Digit4', '4'],
  5: [53, 'Digit5', '5'],
  d: [68, 'KeyD', 'd'],
  o: [79, 'KeyO', 'o'],
  i: [73, 'KeyI', 'i'],
}
const ALT = 1
const SHIFT = 8

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

// The mark on the map is the brand's yellow, #FDC339.
function yellow(img, box = { left: 0, top: 0, right: img.width, bottom: img.height }) {
  let n = 0
  for (let y = box.top; y < box.bottom; y += 2) {
    for (let x = box.left; x < box.right; x += 2) {
      const [r, g, b] = img.at(x, y)
      if (r > 225 && g > 170 && g < 215 && b < 110) n++
    }
  }
  return n
}

async function open(cdp, name, [width, height], { mobile = false, dark = false } = {}) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const page = {
    name,
    errors: [],
    send,
    width,
    height,
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
    async key(key, modifiers = 0) {
      const [code, physical, text] = KEYS[key]
      const params = { key, code: physical, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers }
      const typed = text && !(modifiers & ALT) ? { text } : {}
      await send('Input.dispatchKeyEvent', { type: typed.text ? 'keyDown' : 'rawKeyDown', ...params, ...typed })
      // The game reads arrows held across a frame.
      if (key.startsWith('Arrow')) await sleep(80)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    },
    async type(text) {
      await send('Input.insertText', { text })
    },
    async click(selector) {
      const box = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      if (!box) throw new Error(`${name}: no ${selector}`)
      if (mobile) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] })
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        return
      }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
    },
    async scheme(dark) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    },
    async size(w, h, isMobile = false) {
      page.width = w
      page.height = h
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: isMobile })
    },
    async shot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(joinPath(shots, file), Buffer.from(data, 'base64'))
    },
    // The map alone: everything else hidden for the shot.
    async map() {
      const hide = (v) => page.eval(`(() => { for (const el of document.body.children) if (el.id !== 'game') el.style.visibility = '${v}'; return true })()`)
      await hide('hidden')
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      await hide('')
      return decodePng(Buffer.from(data, 'base64'))
    },
    rect: (selector) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right } })()`),
    active: () => page.eval(`document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName`),
    state: () =>
      page.eval(`(() => {
        const html = document.documentElement
        const panel = document.getElementById('panel')
        const shown = ['chat', 'people', 'rooms', 'settings'].find((id) => !document.getElementById(id + '-panel').hidden) ?? null
        return {
          sidebar: html.dataset.sidebar ?? null,
          panel: html.dataset.panel ?? null,
          shown: panel.hidden ? null : shown,
          title: document.getElementById('panel-title').textContent,
          gameLeft: Math.round(document.getElementById('game').getBoundingClientRect().left),
          drawer: document.getElementById('shell').dataset.layout,
          open: document.getElementById('shell').hasAttribute('data-open'),
          theme: html.dataset.theme ?? null,
          bg: getComputedStyle(document.body).backgroundColor,
          zoom: document.getElementById('zoom-level').hasAttribute('data-overview') ? 'overview' : document.getElementById('zoom-level-value').textContent,
          expanded: Object.fromEntries([...document.querySelectorAll('.nav-item[aria-expanded]')].map((b) => [b.dataset.item ?? b.id, b.getAttribute('aria-expanded')])),
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
  // Counts the moves the page sends, to tell whether keys reached the game.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      window.__moves = 0; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { if (typeof data === 'string' && data.startsWith('{"t":"move"')) window.__moves++; return send.call(this, data) }`,
  })
  await page.size(width, height, mobile)
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.scheme(dark)
  return page
}

async function join(page, name, { fresh = true } = {}) {
  await page.send('Page.navigate', { url: base })
  await page.until(`!document.getElementById('join').hidden`)
  await page.eval(
    `(() => { ${fresh ? 'localStorage.clear();' : ''} const i = document.getElementById('join-name'); i.value = ${JSON.stringify(name)}; document.getElementById('join-form').requestSubmit(); return true })()`,
  )
  await page.until(`!document.getElementById('avatar-edit').disabled && !document.getElementById('shell').hidden`)
  await page.until(`document.getElementById('zoom-level-value').textContent !== '' || document.getElementById('zoom-level').hasAttribute('data-overview')`)
  await sleep(600)
}

// A guest straight on the socket, for a crowd; it can walk a path of steps.
async function bot(name) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?name=${encodeURIComponent(name)}`)
  const me = { ws, id: null, x: 0, y: 0, zone: '' }
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.t === 'welcome') {
      me.id = msg.d.selfId
      const self = msg.d.players.find((p) => p.id === me.id)
      Object.assign(me, { x: self.x, y: self.y })
    }
    if (msg.t === 'state') {
      const self = msg.d.players.find((p) => p.id === me.id)
      if (self) Object.assign(me, { x: self.x, y: self.y })
    }
    if (msg.t === 'zone') me.zone = msg.d.id
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  for (let i = 0; i < 40 && me.id === null; i++) await sleep(50)
  let seq = 0
  me.walk = async (dir, n) => {
    for (let i = 0; i < n; i++) {
      ws.send(JSON.stringify({ t: 'move', d: { seq: ++seq, dir } }))
      await sleep(190)
    }
    await sleep(250)
  }
  // To a tile through the office's walkways: the corridor between the desk
  // blocks (x 24), the strip above them (y 11), then straight up.
  me.goTo = async (x, yInside) => {
    if (me.y > 12) {
      await me.walk(me.x < 24 ? 'right' : 'left', Math.abs(24 - me.x))
      await me.walk('up', me.y - 11)
    }
    await me.walk(me.x < x ? 'right' : 'left', Math.abs(x - me.x))
    await me.walk('up', me.y - yInside)
  }
  me.close = () => ws.close()
  return me
}

/** Where the map is drawn: everything unlike the page's background in a corner. */
function mapBox(img) {
  const bg = img.at(img.width - 1, img.height - 1)
  const far = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 30
  let [left, top, right, bottom] = [img.width, img.height, -1, -1]
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      if (!far(img.at(x, y))) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  return { left, top, right, bottom }
}

async function ensure(page, panel) {
  if ((await page.state()).shown !== panel) await page.click(`.nav-item[data-item="${panel}"]`)
  await sleep(SETTLE)
}

const results = { checks: [], shots }
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

const PANELS = ['chat', 'people', 'rooms', 'settings']

// Every panel, expanded and collapsed, at the page's size and scheme.
async function gallery(page, prefix) {
  for (const collapsed of [false, true]) {
    const wanted = collapsed ? 'collapsed' : 'expanded'
    if ((await page.state()).sidebar !== wanted) await page.click('#sidebar-toggle')
    await sleep(SETTLE)
    for (const panel of PANELS) {
      if ((await page.state()).shown !== panel) await page.click(`.nav-item[data-item="${panel}"]`)
      await sleep(SETTLE)
      await page.eval('document.activeElement?.blur(), true')
      await page.shot(`${prefix}-${wanted}-${panel}.png`)
    }
    await page.click(`.nav-item[data-item="settings"]`)
    await sleep(SETTLE)
    await page.shot(`${prefix}-${wanted}-none.png`)
  }
  await page.click('#sidebar-toggle')
  await sleep(SETTLE)
}

async function desktop(cdp) {
  const ana = await open(cdp, 'ana', [1280, 800])
  const bia = await open(cdp, 'bia', [1280, 800])
  await join(ana, `Ana-${run}`)
  await join(bia, `Bia-${run}`)

  let s = await ana.state()
  check(
    'first visit: the sidebar is expanded and docked, with the chat open beside it, the map to its right',
    s.sidebar === 'expanded' && s.panel === 'chat' && s.shown === 'chat' && s.gameLeft === 240 && s.drawer === 'docked' && s.expanded.chat === 'true',
    s,
  )
  const navNames = await ana.eval(`[...document.querySelectorAll('.sidebar-nav .nav-item')].map((b) => b.getAttribute('aria-label'))`)
  check(
    'the nav is labelled and every item has a name, with the count of people',
    (await ana.eval(`document.querySelector('nav.sidebar-nav').getAttribute('aria-label')`)) === 'Painéis' &&
      navNames.join('|') === 'Chat|Pessoas, 2 no escritório|Salas|Personalizar avatar|Configurações',
    navNames,
  )
  const profile = await ana.eval(`({ name: document.getElementById('profile-name').textContent, place: document.getElementById('profile-place').textContent, drawn: (() => { const c = document.getElementById('profile-head'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0) })() })`)
  check('the profile shows our head, name and place', profile.name === `Ana-${run}` && profile.place === 'Escritório aberto' && profile.drawn, profile)
  await ana.shot('desktop-1280-light-start.png')

  // Collapse to the rail, remembered across a reload.
  await ana.click('#sidebar-toggle')
  await sleep(SETTLE)
  s = await ana.state()
  check(
    'the toggle collapses to a rail of icons and the map grows',
    s.sidebar === 'collapsed' && s.gameLeft === 64 && (await ana.eval(`document.getElementById('sidebar-toggle').getAttribute('aria-expanded')`)) === 'false',
    s,
  )
  const rail = await ana.rect('.nav-item[data-item="rooms"]')
  await ana.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x + rail.width / 2, y: rail.y + rail.height / 2 })
  await sleep(100)
  const tip = await ana.eval(`getComputedStyle(document.querySelector('.nav-item[data-item="rooms"]'), '::after').content`)
  check('an icon of the rail shows its name on hover', rail.width <= 40 && tip === '"Salas"', { tip, rail })
  await ana.shot('desktop-1280-light-rail-tooltip.png')
  await ana.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 400 })
  await ana.send('Page.reload')
  await join(ana, `Ana-${run}`, { fresh: false })
  s = await ana.state()
  check('the collapsed rail and the open panel survive a reload', s.sidebar === 'collapsed' && s.shown === 'chat' && s.gameLeft === 64, s)
  await ana.click('#sidebar-toggle')
  await sleep(SETTLE)
  check('and it expands again', (await ana.state()).sidebar === 'expanded')

  // One panel at a time; the active item closes it.
  await ana.click('.nav-item[data-item="people"]')
  await sleep(SETTLE)
  s = await ana.state()
  const people = await ana.eval(`[...document.querySelectorAll('#people-list .person')].map((li) => ({ name: li.querySelector('.person-name').textContent, place: li.querySelector('.person-place').textContent }))`)
  check(
    'Pessoas lists everyone with where they are',
    s.shown === 'people' && s.title === 'Pessoas' && s.expanded.people === 'true' && s.expanded.chat === 'false' && people.length === 2 && people[0].name === `Ana-${run} (você)` && people.every((p) => p.place === 'Escritório aberto'),
    { s, people },
  )
  await ana.click('.nav-item[data-item="people"]')
  await sleep(SETTLE)
  s = await ana.state()
  check('a click on the active item closes the panel', s.shown === null && s.panel === null && s.expanded.people === 'false', s)
  await ana.click('.nav-item[data-item="people"]')
  await sleep(SETTLE)

  // A direct message from the list.
  await ana.click('#people-list .person:not(.self) .person-action')
  await sleep(SETTLE)
  s = await ana.state()
  const dm = await ana.eval(`({ tab: document.querySelector('.chat-tab[aria-selected="true"]')?.textContent, focus: document.activeElement?.id })`)
  check('the message button opens the conversation in the chat panel', s.shown === 'chat' && dm.tab?.startsWith(`Bia-${run}`) && dm.focus === 'chat-input', { s, dm })
  await ana.type('oi Bia, tudo bem?')
  await ana.key('Enter')
  await bia.until(`document.getElementById('nav-chat-badge').textContent === '1'`)
  const biaChat = await bia.eval(`document.getElementById('nav-chat').getAttribute('aria-label')`)
  check('the other side gets an unread badge on Chat, also for screen readers', biaChat === 'Chat, 1 não lida', biaChat)

  // Keyboard: Alt+3 opens Salas, Esc closes it and gives the focus back.
  await ana.eval('document.activeElement?.blur(), true')
  await ana.key('3', ALT)
  await sleep(SETTLE)
  s = await ana.state()
  const rooms = await ana.eval(`[...document.querySelectorAll('#rooms-list .room')].map((li) => ({ name: li.querySelector('.room-name').textContent, meta: li.querySelector('.room-meta').textContent, here: li.classList.contains('here') }))`)
  check(
    'Alt+3 opens Salas: the rooms, then the open office and the kitchen, with who is where',
    s.shown === 'rooms' &&
      rooms.map((r) => r.name).join('|') === 'Sala de reunião|Sala privada|Ringue de box|Escritório aberto|Copa' &&
      rooms[3].meta === 'Aberta · 2 pessoas' &&
      rooms[3].here &&
      (await ana.active()) === 'nav-rooms',
    { s, rooms },
  )
  await ana.key('Escape')
  await sleep(SETTLE)
  s = await ana.state()
  check('Esc closes the panel and the focus returns to its item', s.shown === null && (await ana.active()) === 'nav-rooms', s)

  // Someone walks into the meeting room and someone else to the kitchen.
  const cris = await bot(`Cris-${run}`)
  const davi = await bot(`Davi-${run}`)
  await cris.goTo(18, 6)
  await davi.goTo(32, 5)
  await ana.key('3', ALT)
  await sleep(SETTLE + 300)
  const crowd = await ana.eval(`Object.fromEntries([...document.querySelectorAll('#rooms-list .room')].map((li) => [li.querySelector('.room-name').textContent, li.querySelectorAll('.room-face').length]))`)
  check('the rooms show who went in, as heads', cris.zone === 'reuniao' && crowd['Sala de reunião'] === 1 && crowd['Copa'] === 1 && crowd['Escritório aberto'] === 2, { crowd, cris: [cris.x, cris.y, cris.zone], davi: [davi.x, davi.y] })
  await ana.shot('desktop-1280-light-rooms-crowd.png')

  // "Ver na visão geral": the overview with the room marked for a while.
  await ana.click('#rooms-list .room:nth-child(5) .room-show')
  await sleep(SETTLE + 100)
  s = await ana.state()
  const marked = await ana.map()
  check('a room\'s button goes to the overview, not saved as the zoom', s.zoom === 'overview' && (await ana.eval(`localStorage.getItem('vb-office-32.zoom')`)) === null, s)
  const lit = yellow(marked)
  await ana.shot('desktop-1280-light-rooms-overview.png')
  await sleep(4600)
  const after = yellow(await ana.map())
  check('and marks it on the map for a few seconds', lit > after + 150, { lit, after })

  // "Ver no mapa" from the people list marks the person.
  await ensure(ana, 'people')
  await ana.click('#people-list .person:nth-child(2) .person-action:last-child')
  await sleep(SETTLE)
  const shown = await ana.map()
  const ring = yellow(shown)
  await ana.shot('desktop-1280-light-people-locate.png')
  await sleep(4600)
  const gone = yellow(await ana.map())
  check('"Ver no mapa" marks the person in the overview, then lets go', (await ana.state()).zoom === 'overview' && ring > gone + 40, { ring, gone })
  const panel = await ana.rect('#panel')
  const box = mapBox(shown)
  check('the overview fits the office beside the sidebar and the panel', panel.right === 600 && box.left >= 600 && box.left < 640 && box.right > 1230, { box, panel })
  await ana.click('#zoom-reset')
  await sleep(SETTLE)

  // A field of a panel holds the game's keys.
  await ensure(ana, 'settings')
  const media = await ana.until(`!document.getElementById('settings-devices').hidden || 'none'`, 8000).catch(() => 'none')
  if (media === true) {
    await ana.eval(`document.getElementById('device-videoinput').focus(), true`)
    const moves = await ana.eval('window.__moves')
    await ana.key('d')
    await ana.key('ArrowLeft')
    await sleep(300)
    check('keys in a field of the sidebar do not walk the avatar', (await ana.eval('window.__moves')) === moves)
    await ana.eval('document.activeElement.blur(), true')
    await ana.key('ArrowLeft')
    await sleep(400)
    check('and walk it again once the field is left', (await ana.eval('window.__moves')) > moves)

    // Devices: Chrome's fake ones; the choice switches and is remembered.
    await ana.until(`document.getElementById('device-audioinput').options.length > 1`, 8000)
    const options = await ana.eval(`[...document.getElementById('device-audioinput').options].map((o) => ({ id: o.value, label: o.textContent }))`)
    const pick = options.find((o) => /1/.test(o.label)) ?? options[1]
    await ana.eval(`(() => { const s = document.getElementById('device-audioinput'); s.value = ${JSON.stringify(pick.id)}; s.dispatchEvent(new Event('change')); return true })()`)
    await sleep(800)
    const saved = await ana.eval(`JSON.parse(localStorage.getItem('vb-office-32.devices') || '{}')`)
    const note = await ana.eval(`document.getElementById('settings-devices-note').textContent`)
    check('a microphone picked in Configurações switches and is remembered', saved.audioinput === pick.id && !/Não deu/.test(note), { options, saved, note })
    await ana.shot('desktop-1280-light-settings-devices.png')
  } else {
    check('devices: skipped, the server has no media', true)
  }
  check('guests have no Sair', (await ana.eval(`document.getElementById('settings-account').hidden`)) === true)

  // Theme: by the system until picked; the pick holds over the system and a reload.
  await ana.click('input[name="theme"][value="dark"]')
  await sleep(200)
  s = await ana.state()
  check('Escuro sets data-theme and the dark tokens', s.theme === 'dark' && s.bg === 'rgb(0, 19, 31)', s)
  await ana.shot('desktop-1280-dark-settings.png')
  await ana.scheme(true)
  await ana.click('input[name="theme"][value="light"]')
  await sleep(200)
  s = await ana.state()
  check('Claro wins over a dark system', s.theme === 'light' && s.bg === 'rgb(246, 246, 246)', s)
  await ana.send('Page.reload')
  await join(ana, `Ana-${run}`, { fresh: false })
  s = await ana.state()
  check('the picked theme survives a reload', s.theme === 'light' && s.bg === 'rgb(246, 246, 246)' && (await ana.eval(`document.querySelector('input[name="theme"]:checked').value`)) === 'light', s)
  await ensure(ana, 'settings')
  await ana.click('input[name="theme"][value="system"]')
  await sleep(200)
  s = await ana.state()
  check('Sistema follows the system again', s.theme === null && s.bg === 'rgb(0, 19, 31)', s)
  await ana.scheme(false)

  // The avatar item opens the editor, which gives the focus back.
  await ana.key('4', ALT)
  await ana.until(`document.getElementById('avatar-editor').open`)
  await ana.key('Escape')
  await ana.until(`!document.getElementById('avatar-editor').open`)
  check('Alt+4 opens the avatar editor; Esc closes it back on the item', (await ana.active()) === 'avatar-edit')

  // While the chat holds the keyboard, Alt+digits are text, not shortcuts.
  await ana.key('1', ALT)
  await sleep(SETTLE)
  await ana.until(`(document.getElementById('chat-input').focus(), document.activeElement.id === 'chat-input')`)
  await ana.key('2', ALT)
  await sleep(SETTLE)
  check('shortcuts wait while the chat has the keyboard', (await ana.state()).shown === 'chat')
  await ana.key('Escape')

  // Screens.
  for (const [w, h] of [
    [1280, 800],
    [1920, 1080],
  ]) {
    await ana.size(w, h)
    for (const dark of [false, true]) {
      await ana.scheme(dark)
      await sleep(SETTLE)
      await gallery(ana, `desktop-${w}-${dark ? 'dark' : 'light'}`)
    }
  }
  await ana.size(1280, 800)
  await ana.scheme(false)

  for (const page of [ana, bia]) {
    check(`${page.name}: no CSP violations`, (await page.eval('window.__csp.length')) === 0, await page.eval('window.__csp'))
    check(`${page.name}: no errors`, page.errors.length === 0, page.errors)
  }
  cris.close()
  davi.close()
  return bia
}

async function phone(cdp, bia) {
  const eva = await open(cdp, 'eva', [390, 844], { mobile: true })
  await join(eva, `Eva-${run}`)
  let s = await eva.state()
  check(
    'phone: the sidebar is a closed drawer, the map full width, a menu button on it',
    s.drawer === 'drawer' && !s.open && s.gameLeft === 0 && s.shown === null && (await eva.eval(`!document.getElementById('menu').hidden && document.getElementById('shell').inert`)),
    s,
  )
  await eva.shot('phone-light-closed.png')

  // A message makes a badge on the menu button.
  await bia.eval('document.activeElement?.blur(), true')
  await bia.key('Enter')
  await bia.until(`document.activeElement?.id === 'chat-input'`)
  await bia.type('bom dia!')
  await bia.key('Enter')
  await eva.until(`!document.getElementById('menu-badge').hidden`)
  check('phone: unread messages show on the menu button', (await eva.eval(`document.getElementById('menu').getAttribute('aria-label')`)) === 'Abrir menu, 1 mensagem não lida')

  await eva.click('#menu')
  await sleep(SETTLE)
  s = await eva.state()
  check(
    'the menu opens the drawer on the chat, with a scrim, the rest of the page inert and the focus inside',
    s.open && s.shown === 'chat' && (await eva.eval(`!document.getElementById('scrim').hidden && document.getElementById('game').inert && document.getElementById('shell').contains(document.activeElement)`)),
    s,
  )
  // Tab stays in the drawer.
  const seen = new Set()
  let inside = true
  for (let i = 0; i < 30; i++) {
    await eva.key('Tab')
    seen.add(await eva.active())
    inside &&= await eva.eval(`document.getElementById('shell').contains(document.activeElement)`)
  }
  check('Tab cycles inside the drawer', inside && seen.size > 4, [...seen])
  for (const panel of PANELS) {
    await eva.click(`.nav-item[data-item="${panel}"]`)
    await sleep(SETTLE)
    s = await eva.state()
    if (s.shown !== panel) check(`phone: ${panel} shows in the drawer`, false, s)
    await eva.shot(`phone-light-${panel}.png`)
  }
  await eva.click(`.nav-item[data-item="settings"]`)
  await sleep(100)
  check('phone: a second tap keeps the panel (the drawer always shows one)', (await eva.state()).shown === 'settings')
  await eva.key('Escape')
  await sleep(SETTLE)
  s = await eva.state()
  check('Esc closes the drawer and the focus goes back to the menu button', !s.open && (await eva.active()) === 'menu' && !(await eva.eval(`document.getElementById('game').inert`)), s)

  // "Ver no mapa" from the drawer: it closes, the overview shows.
  await eva.click('#menu')
  await sleep(SETTLE)
  await eva.click('.nav-item[data-item="people"]')
  await sleep(SETTLE)
  await eva.click('#people-list .person:nth-child(2) .person-action:last-child')
  await sleep(SETTLE + 200)
  s = await eva.state()
  check('phone: "Ver no mapa" closes the drawer and shows the overview', !s.open && s.zoom === 'overview', s)
  await eva.shot('phone-light-locate.png')

  await eva.scheme(true)
  await sleep(200)
  await eva.shot('phone-dark-closed.png')
  await eva.click('#menu')
  await sleep(SETTLE)
  for (const panel of PANELS) {
    await eva.click(`.nav-item[data-item="${panel}"]`)
    await sleep(SETTLE)
    await eva.shot(`phone-dark-${panel}.png`)
  }
  check('phone: no CSP violations', (await eva.eval('window.__csp.length')) === 0, await eva.eval('window.__csp'))
  check('phone: no errors', eva.errors.length === 0, eva.errors)
}

let cdp
try {
  cdp = await devtools()
  const bia = await desktop(cdp)
  await phone(cdp, bia)
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
