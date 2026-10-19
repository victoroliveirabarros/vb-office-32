// Development-only check of the avatars (phase 6.3): walking in the four
// directions, the editor driven by keyboard only, the change reaching
// another client live and surviving a reload, no CSP violations, light and
// dark, desktop and phone. Needs the server in guest mode serving the app
// build (npm run build), then:
//
//   node e2e/avatars.mjs [base URL, default http://localhost:8080] [screenshot dir]
//
// CHROME picks the browser binary and CDP_PORT the DevTools port.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const base = process.argv[2] ?? 'http://localhost:8080'
const shots = process.argv[3] ?? mkdtempSync('/tmp/vbo-shots-')
const port = Number(process.env.CDP_PORT ?? 9334)
mkdirSync(shots, { recursive: true })

// Option counts of the catalog (web/src/avatar/catalog.gen.ts).
const COUNTS = { skin: 5, hair: 7, hairColor: 8, shirt: 8, pants: 4, acc: 4 }
// The bald hair style: the hair color group is disabled.
const BALD = 6
const FIELDS = Object.keys(COUNTS)
const compact = (a) => FIELDS.map((f) => a[f] ?? 0).join('.')

// Fresh names: the server remembers a returning identity's look.
const run = Date.now().toString(36).slice(-5)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
let chromeLog = ''
chrome.stderr.on('data', (chunk) => (chromeLog = (chromeLog + chunk).slice(-20_000)))

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
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
}

// Every page gets its own browser context: separate storage, as two people.
async function open(cdp, name, size) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const page = {
    name,
    frames: [],
    sockets: [],
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
    async key(key, { up = true, shift = false } = {}) {
      const code = KEYS[key]
      const params = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(key === 'Enter' ? { text: '\r' } : {}) })
      if (up) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    },
    keyUp(key) {
      const code = KEYS[key]
      return send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    },
    async size(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
      await sleep(400)
    },
    async scheme(dark) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
      await sleep(200)
    },
    async shot(file, clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 3 } } : {}) })
      writeFileSync(joinPath(shots, file), Buffer.from(data, 'base64'))
    },
    received: (t) => page.frames.filter((f) => f.t === t),
    active: () => page.eval('document.activeElement?.id || document.activeElement?.name || document.activeElement?.tagName'),
  }
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return
    // The game's socket only; LiveKit's, with media on, is not ours.
    if (msg.method === 'Network.webSocketCreated' && new URL(msg.params.url).pathname === '/ws') page.sockets.push(msg.params.url)
    if (msg.method === 'Network.webSocketFrameReceived') {
      try {
        page.frames.push({ at: Date.now(), ...JSON.parse(msg.params.response.payloadData) })
      } catch {
        // not JSON
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') page.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    // Guest mode answers /api/session with 401 by design; nobody serves a favicon.
    const { entry } = msg.params ?? {}
    if (msg.method === 'Log.entryAdded' && entry.level === 'error' && !/\/api\/session$|\/favicon\.ico$/.test(entry.url ?? '')) {
      page.errors.push(`${entry.text} ${entry.url ?? ''}`)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Log.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sourceFile || '') + ':' + e.lineNumber))`,
  })
  await page.size(...size)
  await page.scheme(false)
  return page
}

// Guest mode: the name screen, then the welcome enables "Personalizar".
async function join(page, name) {
  await page.send('Page.navigate', { url: base })
  await page.until(`!document.getElementById('join').hidden`)
  await page.eval(`(() => { const i = document.getElementById('join-name'); i.value = ${JSON.stringify(name)}; document.getElementById('join-form').requestSubmit(); return true })()`)
  await page.until(`document.getElementById('avatar-edit') && !document.getElementById('avatar-edit').disabled`)
  await sleep(500)
}

const results = { checks: [], shots }
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

function selfLook(page) {
  const welcome = page.received('welcome').at(-1)
  return welcome?.d.players.find((p) => p.id === welcome.d.selfId)?.appearance
}

// The camera follows our avatar: it stands at the middle of the screen,
// its feet on the bottom of the tile there.
const AROUND_SELF = (w, h, zoom) => ({ x: w / 2 - 28 * zoom, y: h / 2 - 44 * zoom, width: 56 * zoom, height: 72 * zoom })

async function walk(page, prefix) {
  const zoom = 3
  const clip = AROUND_SELF(1280, 800, zoom)
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
    await page.key(key, { up: false })
    for (let i = 0; i < 3; i++) {
      await sleep(55)
      await page.shot(`${prefix}-${key.slice(5).toLowerCase()}-${i}.png`, clip)
    }
    await page.keyUp(key)
    await sleep(400)
    await page.shot(`${prefix}-${key.slice(5).toLowerCase()}-idle.png`, clip)
  }
}

async function tabTo(page, id, max = 30) {
  for (let i = 0; i < max; i++) {
    if ((await page.active()) === id) return true
    await page.key('Tab')
  }
  return (await page.active()) === id
}

async function scenario(cdp) {
  const ana = await open(cdp, 'Ana', [1280, 800])
  const bia = await open(cdp, 'Bia', [1280, 800])
  await join(ana, `Ana-${run}`)
  await join(bia, `Bia-${run}`)
  const anaId = ana.received('welcome').at(-1)?.d.selfId
  const look0 = selfLook(ana)
  check('welcome carries our appearance', look0 && FIELDS.every((f) => Number.isInteger(look0[f])), look0)
  check('first connection sends no av', !ana.sockets[0]?.includes('av='), ana.sockets)
  const anaInBia = bia.received('welcome').at(-1)?.d.players.find((p) => p.id === anaId)
  check('the other client gets our look in its welcome', anaInBia && compact(anaInBia.appearance) === compact(look0), anaInBia)

  await ana.shot('a-desktop-light.png')
  await walk(ana, 'walk')

  // Keyboard only, from the page: Tab to "Personalizar", Enter.
  await ana.eval('document.activeElement?.blur(), true')
  check('Tab reaches Personalizar', await tabTo(ana, 'avatar-edit'))
  await ana.key('Enter')
  await ana.until(`document.getElementById('avatar-editor').open`)
  const openAt = Date.now()
  check('the dialog opens modal with focus on the chosen skin', (await ana.active()) === 'avatar-skin', await ana.active())
  await sleep(400)
  await ana.shot('editor-desktop-light-open.png')

  // One step right in every group; the hair color two, and the hair style
  // two when one would make the head bald.
  const want = { ...look0 }
  for (const [i, field] of FIELDS.entries()) {
    if (i > 0) await ana.key('Tab')
    const steps = field === 'hairColor' || (field === 'hair' && (look0.hair + 1) % COUNTS.hair === BALD) ? 2 : 1
    for (let s = 0; s < steps; s++) await ana.key('ArrowRight')
    want[field] = (look0[field] + steps) % COUNTS[field]
  }
  const shown = await ana.eval(`[...document.querySelectorAll('#avatar-options input:checked')].map((i) => i.value).join('.')`)
  check('arrows pick the next options', shown === compact(want), { shown, want: compact(want) })
  const label = await ana.eval(`document.getElementById('avatar-preview').getAttribute('aria-label')`)
  check('the preview describes the draft', /^Prévia do avatar: Pele tom \d/.test(label), label)
  const moved = ana.received('state').filter((f) => f.at >= openAt && f.d.players.some((p) => p.id === anaId))
  check('the game ignores arrows while editing', moved.length === 0, moved)
  await ana.shot('editor-desktop-light-draft.png')

  check('Tab reaches Salvar', await tabTo(ana, 'avatar-save', 6))
  const savedAt = Date.now()
  await ana.key('Enter')
  await ana.until(`!document.getElementById('avatar-editor').open`)
  check('focus returns to Personalizar', (await ana.active()) === 'avatar-edit', await ana.active())
  const stored = await ana.eval(`localStorage.getItem('vb-office-32.avatar')`)
  check('the look is saved in the browser', stored === compact(want), stored)

  await bia.until('true')
  const live = await (async () => {
    const end = Date.now() + 5_000
    while (Date.now() < end) {
      const m = bia.received('appearance').find((f) => f.at >= savedAt && f.d.id === anaId)
      if (m) return m
      await sleep(25)
    }
    return null
  })()
  check('the other client receives the change live', live && compact(live.d.appearance) === compact(want), live?.d)
  const echo = ana.received('appearance').find((f) => f.at >= savedAt && f.d.id === anaId)
  check('our client gets the change too', echo && compact(echo.d.appearance) === compact(want), echo?.d)
  await sleep(300)
  await bia.shot('b-sees-change.png')
  await ana.shot('a-after-save.png', AROUND_SELF(1280, 800, 3))

  // Esc throws the draft away.
  await ana.key('Enter')
  await ana.until(`document.getElementById('avatar-editor').open`)
  await ana.key('ArrowRight')
  const sentBefore = ana.received('appearance').length
  await ana.key('Escape')
  await ana.until(`!document.getElementById('avatar-editor').open`)
  await sleep(300)
  check('Esc cancels without saving or sending', (await ana.eval(`localStorage.getItem('vb-office-32.avatar')`)) === compact(want) && ana.received('appearance').length === sentBefore)

  // Aleatório changes the draft, Cancelar puts it back.
  await ana.key('Enter')
  await ana.until(`document.getElementById('avatar-editor').open`)
  check('Tab reaches Aleatório', await tabTo(ana, 'avatar-random', 12))
  await ana.key('Enter')
  const randomized = await ana.eval(`[...document.querySelectorAll('#avatar-options input:checked')].map((i) => i.value).join('.')`)
  check('Aleatório shows another look', randomized !== compact(want), randomized)
  await ana.key('Tab')
  await ana.key('Enter')
  await ana.until(`!document.getElementById('avatar-editor').open`)
  await ana.key('Enter')
  await ana.until(`document.getElementById('avatar-editor').open`)
  const reopened = await ana.eval(`[...document.querySelectorAll('#avatar-options input:checked')].map((i) => i.value).join('.')`)
  check('Cancelar reverts the draft', reopened === compact(want), reopened)
  await ana.key('Escape')

  // Careca: the hair color group is disabled, says why and keeps its choice.
  await ana.key('Enter')
  await ana.until(`document.getElementById('avatar-editor').open`)
  await ana.key('Tab')
  check('Tab reaches the hair styles', (await ana.active()) === 'avatar-hair', await ana.active())
  for (let s = 0; s < (BALD - want.hair + COUNTS.hair) % COUNTS.hair; s++) await ana.key('ArrowRight')
  const colorGroup = `document.querySelector('input[name="avatar-hairColor"]').closest('fieldset')`
  const bald = await ana.eval(`(() => {
    const group = ${colorGroup}
    const hint = group.querySelector('.editor-hint')
    return {
      hair: document.querySelector('input[name="avatar-hair"]:checked')?.value,
      disabled: group.disabled,
      hint: hint && !hint.hidden && hint.getBoundingClientRect().width > 0 ? hint.textContent : null,
      kept: document.querySelector('input[name="avatar-hairColor"]:checked')?.value,
      label: document.getElementById('avatar-preview').getAttribute('aria-label'),
      thumb: (() => {
        const c = document.querySelectorAll('input[name="avatar-hair"]')[${BALD}].parentElement.querySelector('canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
        return n
      })(),
    }
  })()`)
  check('arrows reach Careca', bald.hair === String(BALD), bald)
  check('Careca disables the hair color, saying why', bald.disabled && bald.hint === 'Sem cabelo', bald)
  check('the hair color is kept while bald', bald.kept === String(want.hairColor), bald)
  check('the preview says careca', / careca, /.test(bald.label) && !/cabelo careca/.test(bald.label), bald.label)
  check('the Careca thumbnail shows the head', bald.thumb > 100, bald.thumb)
  await ana.key('Tab')
  check('Tab skips the disabled hair colors', (await ana.active()) === 'avatar-shirt', await ana.active())
  await sleep(300)
  await ana.shot('editor-bald-light.png')
  const editorBox = `(() => { const r = document.getElementById('avatar-editor').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
  await ana.shot('editor-bald-light-zoom.png', await ana.eval(editorBox))
  await ana.scheme(true)
  await ana.shot('editor-bald-dark-zoom.png', await ana.eval(editorBox))
  await ana.scheme(false)
  await ana.key('Tab', { shift: true })
  await ana.key('ArrowLeft')
  const back = await ana.eval(`({ disabled: (${colorGroup}).disabled, color: document.querySelector('input[name="avatar-hairColor"]:checked')?.value })`)
  check('another style brings the hair color back', !back.disabled && back.color === String(want.hairColor), back)
  await ana.key('Escape')
  await ana.until(`!document.getElementById('avatar-editor').open`)

  // Reload: the saved look goes in the URL and comes back in the welcome.
  ana.frames.length = 0
  await join(ana, `Ana-${run}`)
  check('reload sends the saved look in ?av=', ana.sockets.at(-1)?.includes(`av=${compact(want)}`), ana.sockets.at(-1))
  check('reload keeps the look', compact(selfLook(ana) ?? {}) === compact(want), selfLook(ana))

  // Dark theme and the phone.
  await ana.scheme(true)
  await ana.shot('a-desktop-dark.png')
  await ana.eval(`document.getElementById('avatar-edit').click(), true`)
  await ana.until(`document.getElementById('avatar-editor').open`)
  await sleep(300)
  await ana.shot('editor-desktop-dark.png')
  await ana.key('Escape')

  for (const dark of [false, true]) {
    await ana.scheme(dark)
    await ana.size(390, 844, true)
    const theme = dark ? 'dark' : 'light'
    await ana.shot(`a-phone-${theme}.png`)
    await ana.eval(`document.getElementById('avatar-edit').click(), true`)
    await ana.until(`document.getElementById('avatar-editor').open`)
    await sleep(300)
    await ana.shot(`editor-phone-${theme}.png`)
    const fits = await ana.eval(`(() => { const r = document.getElementById('avatar-editor').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })()`)
    check(`the editor fits the phone (${theme})`, fits)
    await ana.key('Escape')
  }

  for (const page of [ana, bia]) {
    const csp = await page.eval('window.__csp')
    check(`${page.name}: no CSP violations`, csp.length === 0, csp)
    check(`${page.name}: no errors`, page.errors.length === 0, page.errors)
  }
}

let failed = true
try {
  const cdp = await devtools()
  await scenario(cdp)
  failed = results.checks.some((c) => !c.ok)
} catch (err) {
  results.error = err instanceof Error ? err.stack : String(err)
} finally {
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}
console.log(JSON.stringify(results, null, 2))
if (failed && chromeLog) console.error(`Chrome stderr:\n${chromeLog}`)
process.exit(failed ? 1 : 0)
