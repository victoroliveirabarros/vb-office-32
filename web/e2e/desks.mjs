// Development-only check of the desks (phase 7b): "ana" sits down at her
// desk on arrival and sees it named after her; "eve" can neither walk in
// with the keyboard nor with raw moves on a socket of her own; ana invites
// eve from Pessoas, eve gets a toast, walks in, the nearby tab turns into
// "Mesa de ana" and both hear each other; the revocation puts eve out of
// the desk, out of earshot; a click on eve's avatar offers ana the invite;
// her desk in Salas lists her guests, offline ones too, and takes an invite
// back; ana leaving shows her desk offline. Salas lists the desks; with media,
// the share button speaks of the desk; no CSP violations; screenshots light
// and dark at 1280×800 and 390×844. Needs a fresh server (or 30 s after the
// last run, the desk's grace) in guest mode with the example owners,
// serving the app build (npm run build); guest mode with desks only listens
// on localhost:
//
//   VB_OFFICE32_AUTH=guest VB_OFFICE32_ADDR=127.0.0.1:8080 VB_OFFICE32_DESKS_FILE=docs/desks.example.json go run ./cmd/vb-office-32
//   node e2e/desks.mjs [base URL, default http://127.0.0.1:8080] [screenshot dir]
//
// CHROME picks the browser binary and CDP_PORT the DevTools port.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { inflateSync } from 'node:zlib'

const base = process.argv[2] ?? 'http://127.0.0.1:8080'
const shots = process.argv[3] ?? mkdtempSync('/tmp/vbo-shots-')
const port = Number(process.env.CDP_PORT ?? 9337)
mkdirSync(shots, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Longer than the zoom and the sidebar's slide.
const SETTLE = 450
// A step of the server, with room for the tick.
const STEP = 230

// Tiles of maps/office.tmj: mesa-01 is x 15–17 on the chair row y 13 and
// the desk row y 14; ana's seat is its middle chair, the strip above y 12.
const SEAT = { x: 16, y: 13 }
const DOOR = { x: 15, y: 12 }

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

const KEYS = {
  ArrowUp: [38, 'ArrowUp'],
  ArrowDown: [40, 'ArrowDown'],
  ArrowLeft: [37, 'ArrowLeft'],
  ArrowRight: [39, 'ArrowRight'],
  '-': [189, 'Minus'],
}
const ARROW = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }

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

// Pixels of the desk signs' pill, #0E3A58 at 0.9 over the floor.
function signPixels(img) {
  let n = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b] = img.at(x, y)
      if (Math.abs(r - 14) < 14 && Math.abs(g - 58) < 14 && Math.abs(b - 88) < 14) n++
    }
  }
  return n
}

async function open(cdp, name, [width, height], { mobile = false } = {}) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const page = {
    name,
    errors: [],
    send,
    targetId,
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
      const [code, physical] = KEYS[key]
      const params = { key, code: physical, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
      // The game reads keys held across a frame.
      await sleep(80)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    },
    // Clicks the element the expression returns, as a finger or a mouse would.
    async clickOn(expression) {
      const box = await page.eval(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      if (!box) throw new Error(`${name}: nothing at ${expression}`)
      if (mobile) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] })
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        return
      }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
    },
    click: (selector) => page.clickOn(`document.querySelector(${JSON.stringify(selector)})`),
    async scheme(dark) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    },
    async shot(file) {
      await page.eval('document.activeElement?.blur(), true')
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
    // What the page's own socket was told.
    net: () => page.eval('window.__net'),
    async panel(item) {
      const shown = await page.eval(`['chat', 'people', 'rooms', 'settings'].find((id) => !document.getElementById(id + '-panel').hidden && !document.getElementById('panel').hidden) ?? null`)
      if (shown !== item) await page.click(`.nav-item[data-item="${item}"]`)
      await sleep(SETTLE)
    },
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
  // Counts the moves sent and keeps what the server told about us.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      window.__moves = 0; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { if (typeof data === 'string' && data.startsWith('{"t":"move"')) window.__moves++; return send.call(this, data) };
      window.__net = { self: null, x: 0, y: 0, dir: '', zone: '', nearby: [], desks: [] };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args)
          if (new URL(this.url).pathname !== '/ws') return
          this.addEventListener('message', (e) => {
            const { t, d } = JSON.parse(e.data), net = window.__net
            const me = (players) => players.find((p) => p.id === net.self)
            if (t === 'welcome') { net.self = d.selfId; Object.assign(net, (({ x, y, dir }) => ({ x, y, dir }))(me(d.players))) }
            if (t === 'state') { const p = me(d.players); if (p) Object.assign(net, { x: p.x, y: p.y, dir: p.dir }) }
            if (t === 'zone') net.zone = d.id
            if (t === 'nearby') net.nearby = d.ids
            if (t === 'desks') net.desks = d.desks
          })
        }
      }`,
  })
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.scheme(false)
  return page
}

async function join(page, name) {
  await page.send('Page.navigate', { url: base })
  await page.until(`!document.getElementById('join').hidden`)
  await page.eval(`(() => { localStorage.clear(); const i = document.getElementById('join-name'); i.value = ${JSON.stringify(name)}; document.getElementById('join-form').requestSubmit(); return true })()`)
  await page.until(`!document.getElementById('avatar-edit').disabled && !document.getElementById('shell').hidden`)
  await page.until(`window.__net.self !== null && window.__net.desks.length > 0`)
  await sleep(600)
}

// The walkways to a tile on the strip above the desks: from below them,
// by the corridor between the blocks (x 24).
function route(from, to) {
  return from.y > 12 ? [{ x: 24 }, { y: 12 }, { x: to.x }, { y: to.y }] : [{ x: to.x }, { y: to.y }]
}

// Walks with the keyboard, one step a press.
async function walk(page, to) {
  for (const leg of route(await page.net(), to)) {
    const [axis, target] = Object.entries(leg)[0]
    for (let i = 0; i < 40; i++) {
      const net = await page.net()
      const d = target - net[axis]
      if (d === 0) break
      await page.key(ARROW[axis === 'x' ? (d > 0 ? 'right' : 'left') : d > 0 ? 'down' : 'up'])
      await sleep(STEP)
    }
  }
  const net = await page.net()
  return net.x === to.x && net.y === to.y
}

// A guest straight on the socket, as a modified client would be.
async function bot(name) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?name=${encodeURIComponent(name)}`)
  const me = { ws, id: null, x: 0, y: 0, zone: '', zones: [] }
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
    if (msg.t === 'zone') {
      me.zone = msg.d.id
      me.zones.push(msg.d.id)
    }
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
  me.goTo = async (to) => {
    for (const leg of route(me, to)) {
      const [axis, target] = Object.entries(leg)[0]
      const d = target - me[axis]
      await me.walk(axis === 'x' ? (d > 0 ? 'right' : 'left') : d > 0 ? 'down' : 'up', Math.abs(d))
    }
  }
  me.close = () => ws.close()
  return me
}

const results = { checks: [], shots }
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

const personRow = (who) => `[...document.querySelectorAll('#people-list .person')].find((li) => li.querySelector('.person-name').textContent === ${JSON.stringify(who)})`
const deskRows = `[...document.querySelectorAll('#desks-list .room')].map((li) => ({ name: li.querySelector('.room-name').textContent, meta: li.querySelector('.room-meta').textContent, locked: li.classList.contains('locked'), here: li.classList.contains('here'), faces: li.querySelectorAll('.room-face').length }))`
const tabLabels = `[...document.querySelectorAll('.chat-tab-label')].map((l) => l.textContent)`

async function scenario(cdp) {
  const ana = await open(cdp, 'ana', [1280, 800])
  const eve = await open(cdp, 'eve', [1280, 800])
  await join(ana, 'ana')
  await join(eve, 'eve')

  // Ana sits down at her desk and it carries her name.
  let a = await ana.net()
  check('ana, an owner, arrives on the seat of her desk', a.x === SEAT.x && a.y === SEAT.y && a.zone === 'mesa-01', a)
  const mine = a.desks.find((d) => d.id === 'mesa-01')
  check('the desks say mesa-01 is hers, online and locked', mine?.owner?.id === a.self && mine.owner.name === 'ana' && mine.online && mine.locked, mine)
  const strip = await ana.eval(`({ text: document.getElementById('zone').textContent, kind: document.getElementById('zone').dataset.kind, place: document.getElementById('profile-place').textContent })`)
  check('the strip and the profile say "Mesa de ana"', strip.text === 'Mesa de ana' && strip.kind === 'desk' && strip.place === 'Mesa de ana', strip)
  check('her nearby chat tab is "Mesa de ana"', (await ana.eval(tabLabels)).includes('Mesa de ana'), await ana.eval(tabLabels))
  const share = await ana.until(`!document.getElementById('media-screen').hidden && document.getElementById('media-screen').title`, 8000).catch(() => null)
  if (share !== null) check('with media, the share button at the desk speaks of the desk', share === 'Compartilhar tela com quem está na mesa', share)
  else check('media: skipped, the server has no media', true)
  await ana.panel('rooms')
  let desks = await ana.eval(deskRows)
  check(
    'Salas lists the 12 desks after their owners: hers online and here, an owner never seen offline and closed, the others free',
    desks.length === 12 &&
      desks[0].name === 'Mesa de ana' && desks[0].meta === 'Online · 1 pessoa' && desks[0].here && !desks[0].locked &&
      desks[1].name === 'Mesa de Bruno Lima' && desks[1].meta === 'Offline · fechada · Vazia' && desks[1].locked &&
      desks[2].name === 'Mesa 3' && desks[2].meta === 'Livre · Vazia' && !desks[2].locked &&
      desks[6].name === 'Mesa 7' && desks[6].meta === 'Offline · fechada · Vazia',
    desks,
  )
  await ana.shot('desktop-1280-light-owner-rooms.png')
  await ana.key('-')
  for (let i = 0; i < 6; i++) {
    if (await ana.eval(`document.getElementById('zoom-level').hasAttribute('data-overview')`)) break
    await ana.key('-')
    await sleep(SETTLE)
  }
  await sleep(SETTLE)
  const pills = signPixels(await ana.map())
  check('the map shows a sign on every desk', pills > 12 * 150, { pills })
  await ana.shot('desktop-1280-light-owner-overview.png')

  // Eve cannot walk in, neither with the keyboard nor with raw moves.
  check('eve walks to the strip above mesa-01', await walk(eve, DOOR), await eve.net())
  const moves = await eve.eval('window.__moves')
  await eve.key('ArrowDown')
  await sleep(STEP * 2)
  await eve.key('ArrowDown')
  await sleep(STEP * 2)
  let e = await eve.net()
  check(
    'eve presses down into the desk and only turns',
    e.x === DOOR.x && e.y === DOOR.y && e.dir === 'down' && e.zone === '' && (await eve.eval('window.__moves')) === moves + 2,
    e,
  )
  await eve.panel('rooms')
  desks = await eve.eval(deskRows)
  check('for eve, ana\'s desk is online but closed', desks[0].meta.startsWith('Online · 1 pessoa') && desks[0].locked && !desks[0].here, desks[0])
  await eve.shot('desktop-1280-light-guest-locked.png')

  const mallory = await bot('mallory')
  await mallory.goTo({ x: 17, y: 12 })
  const at = { x: mallory.x, y: mallory.y }
  await mallory.walk('down', 6)
  await mallory.walk('right', 1)
  check('raw moves from a socket never enter the desk', at.x === 17 && at.y === 12 && mallory.y === 12 && !mallory.zones.includes('mesa-01'), { at, now: [mallory.x, mallory.y], zones: mallory.zones })
  mallory.close()

  // Ana invites eve from Pessoas.
  await ana.panel('people')
  const invite = await ana.eval(`(() => { const b = ${personRow('eve')}?.querySelector('.person-invite'); return b && !b.hidden && { label: b.getAttribute('aria-label'), title: b.title } })()`)
  check('ana, who owns a desk, gets an invite button on eve\'s row and none on hers', invite?.label === 'Convidar eve para minha mesa' && invite.title === 'Convidar para minha mesa' && (await ana.eval(`${personRow('ana (você)')}.querySelector('.person-invite').hidden`)), invite)
  check('eve, without a desk, gets no invite buttons', await eve.eval(`[...document.querySelectorAll('.person-invite')].every((b) => b.hidden)`))
  await ana.shot('desktop-1280-light-owner-people.png')
  await ana.clickOn(`${personRow('eve')}.querySelector('.person-invite')`)
  const toast = await eve.until(`document.querySelector('#toasts .toast')?.textContent`, 5000).catch(() => null)
  check('eve gets a toast with the owner\'s name', toast === 'ana convidou você para a mesa', toast)
  await eve.shot('desktop-1280-light-guest-toast.png')
  const revoke = await ana.until(`(() => { const b = ${personRow('eve')}?.querySelector('.person-invite'); return b?.title === 'Remover convite' && b.getAttribute('aria-label') })()`, 5000).catch(() => null)
  check('the button turns into "Remover convite" once the server agrees', revoke === 'Remover convite de eve', revoke)

  // Eve walks in and the two hear each other.
  await eve.key('ArrowDown')
  await sleep(STEP * 2)
  e = await eve.net()
  a = await ana.net()
  check('invited, eve walks into the desk', e.x === DOOR.x && e.y === SEAT.y && e.zone === 'mesa-01', e)
  check('and both hear each other', e.nearby.includes(a.self) && a.nearby.includes(e.self), { eve: e.nearby, ana: a.nearby })
  await eve.panel('chat')
  const inside = await eve.eval(`({ tabs: ${tabLabels}, strip: document.getElementById('zone').textContent })`)
  check('eve\'s nearby tab and strip say "Mesa de ana"', inside.tabs.includes('Mesa de ana') && inside.strip === 'Mesa de ana', inside)
  await eve.click('.chat-tab:nth-child(2)')
  await sleep(SETTLE)
  const notice = await eve.eval(`document.getElementById('chat-notice').textContent`)
  check('the nearby notice says only the desk sees it', notice === 'Visível só para quem está na mesa: ana.', notice)
  await eve.shot('desktop-1280-light-guest-inside.png')

  // The revocation puts eve out, out of earshot.
  await ana.clickOn(`${personRow('eve')}.querySelector('.person-invite')`)
  await eve.until(`window.__net.zone === '' && window.__net.y === 12`, 5000).catch(() => null)
  await sleep(STEP)
  e = await eve.net()
  a = await ana.net()
  check('revoked, eve is put out on the strip, out of earshot', e.x === DOOR.x && e.y === DOOR.y && e.zone === '' && !e.nearby.includes(a.self) && !a.nearby.includes(e.self), { eve: e, ana: a.nearby })
  const gone = await eve.until(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).find((t) => t.startsWith('Convite'))`, 5000).catch(() => null)
  check('and gets a toast saying so', gone === 'Convite para a mesa de ana removido', gone)

  // A click on eve's avatar offers ana a message or the invite. The camera
  // follows ana in the middle of the map at a whole level.
  await ana.click('#zoom-reset')
  await sleep(SETTLE * 2)
  const view = await ana.eval(`(() => { const r = document.getElementById('game').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, zoom: parseInt(document.getElementById('zoom-level-value').textContent, 10) } })()`)
  const pick = { x: view.x + (DOOR.x - SEAT.x) * 32 * view.zoom, y: view.y + (DOOR.y - SEAT.y) * 32 * view.zoom }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await ana.send('Input.dispatchMouseEvent', { type, ...pick, button: 'left', clickCount: 1 })
  const popover = await ana.until(`!document.getElementById('person-popover').hidden && { name: document.getElementById('person-popover-name').textContent, invite: document.getElementById('person-popover-invite').textContent, focus: document.activeElement?.id }`, 3000).catch(() => null)
  check('a click on eve\'s avatar opens the popover with a message and the invite', popover?.name === 'eve' && popover.invite === 'Convidar para minha mesa' && popover.focus === 'person-popover-message', { popover, view })
  await ana.shot('desktop-1280-light-owner-popover.png')
  await ana.click('#person-popover-invite')
  const again = await eve.until(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).includes('ana convidou você para a mesa')`, 5000).catch(() => false)
  const turned = await ana.until(`document.getElementById('person-popover-invite').textContent === 'Remover convite'`, 5000).catch(() => false)
  check('its invite reaches eve and the popover offers to take it back', again && turned)
  await ana.click('#person-popover-invite')
  await ana.until(`document.getElementById('person-popover-invite').textContent === 'Convidar para minha mesa'`, 5000).catch(() => null)
  await ana.eval(`document.getElementById('person-popover-message').focus(), true`)
  await ana.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await ana.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(100)
  check('Esc closes the popover', await ana.eval(`document.getElementById('person-popover').hidden && !document.getElementById('panel').hidden`))

  // Her desk in Salas lists her guests, also one gone offline, whom Pessoas
  // no longer shows, and takes the invite back from there.
  const otto = await bot('otto')
  await ana.panel('people')
  await ana.until(`${personRow('otto')}?.querySelector('.person-invite')?.hidden === false`, 5000)
  await ana.clickOn(`${personRow('otto')}.querySelector('.person-invite')`)
  await ana.panel('rooms')
  const guestRows = `[...document.querySelectorAll('#desks-list .desk-guest')].map((li) => ({ name: li.querySelector('.desk-guest-name').textContent, status: li.querySelector('.desk-guest-status').textContent, revoke: li.querySelector('.desk-guest-revoke').getAttribute('aria-label') }))`
  const online = await ana.until(`(() => { const r = ${guestRows}; return r.length === 1 && r[0].status === 'Online' && r })()`, 5000).catch(() => null)
  check('Salas lists otto, invited, on her own desk with a way to take it back', online?.[0].name === 'otto' && online[0].revoke === 'Remover convite de otto', online)
  check('and on her desk alone', await ana.eval(`document.querySelectorAll('#desks-list .desk-guests').length === 1 && document.querySelector('#desks-list .room .desk-guests') === document.querySelector('#desks-list .room:first-child .desk-guests')`))
  otto.close()
  const away = await ana.until(`(() => { const r = ${guestRows}; return r[0]?.status === 'Offline' && r })()`, 5000).catch(() => null)
  check('otto gone offline stays listed', away?.length === 1 && away[0].name === 'otto', away)
  await ana.shot('desktop-1280-light-owner-guests.png')
  await ana.clickOn(`document.querySelector('#desks-list .desk-guest-revoke')`)
  const cleared = await ana.until(`document.querySelectorAll('#desks-list .desk-guest').length === 0 && document.querySelector('#desks-list .desk-guests').hidden`, 5000).catch(() => false)
  check('"Remover convite" takes back the invite of a guest offline', cleared === true)

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light'
    for (const page of [ana, eve]) await page.scheme(dark)
    await sleep(SETTLE)
    await ana.panel('rooms')
    await ana.shot(`desktop-1280-${theme}-owner-desks.png`)
    await ana.panel('people')
    await ana.shot(`desktop-1280-${theme}-owner-people-invite.png`)
    await eve.panel('rooms')
    await eve.shot(`desktop-1280-${theme}-guest-desks.png`)
  }
  for (const page of [ana, eve]) await page.scheme(false)

  // A phone sees the desks too.
  const zoe = await open(cdp, 'zoe', [390, 844], { mobile: true })
  await join(zoe, 'zoe')
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light'
    await zoe.scheme(dark)
    await sleep(SETTLE)
    await zoe.shot(`phone-${theme}-map.png`)
    await zoe.click('#menu')
    await sleep(SETTLE)
    await zoe.click('.nav-item[data-item="rooms"]')
    await sleep(SETTLE)
    await zoe.eval(`document.getElementById('desks-section').scrollIntoView(), true`)
    await sleep(100)
    await zoe.shot(`phone-${theme}-desks.png`)
    await zoe.eval(`document.getElementById('drawer-close').click(), true`)
    await sleep(SETTLE)
  }
  check('phone: the desks are listed', (await zoe.eval(deskRows)).length === 12)

  // Ana leaves: her desk shows offline.
  const pages = [ana, eve, zoe]
  const csp = []
  for (const page of pages) csp.push([page.name, await page.eval('window.__csp')])
  await cdp.send('Target.closeTarget', { targetId: ana.targetId })
  const offline = await eve.until(`window.__net.desks.find((d) => d.id === 'mesa-01')?.online === false`, 5000).catch(() => false)
  check('ana leaving shows her desk offline', offline === true, (await eve.net()).desks[0])
  for (const [name, list] of csp) check(`${name}: no CSP violations`, list.length === 0, list)
  for (const page of pages) check(`${page.name}: no errors`, page.errors.length === 0, page.errors)
}

let cdp
try {
  cdp = await devtools()
  await scenario(cdp)
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
