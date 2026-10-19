// Development-only check of the map zoom: the default per screen, the +/−
// buttons, Ctrl+wheel, the + - 0 keys (not while typing), a pinch on a
// phone, the level surviving a reload, no CSP violations. Needs the server in
// guest mode serving the app build (npm run build), then:
//
//   node e2e/zoom.mjs [base URL, default http://localhost:8080] [screenshot dir]
//
// CHROME picks the browser binary and CDP_PORT the DevTools port.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

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

const KEYS = { '+': [187, 'Equal', 8], '=': [187, 'Equal', 0], '-': [189, 'Minus', 0], 0: [48, 'Digit0', 0], Enter: [13, 'Enter', 0], Escape: [27, 'Escape', 0] }

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
    // modifiers: 2 is Ctrl, 4 is ⌘.
    wheel(deltaY, modifiers) {
      return send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width / 3, y: height / 2, deltaX: 0, deltaY, modifiers })
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
        return {
          level: document.getElementById('zoom-level').textContent,
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
  await page.until(`!document.getElementById('zoom').hidden && document.getElementById('zoom-level').textContent !== ''`)
  await page.until(`document.getElementById('avatar-edit') && !document.getElementById('avatar-edit').disabled`)
  await sleep(600)
}

const results = { checks: [], shots }
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

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
  await page.shot('desktop-4x.png')
  await page.click('zoom-in')
  await sleep(100)
  check('+ at the limit does nothing', (await page.state()).level === '4×')

  await page.click('zoom-out')
  await sleep(SETTLE)
  await page.key('-')
  await sleep(SETTLE)
  s = await page.state()
  check('− and the - key step out', s.level === '2×' && s.saved === '2', s)
  await page.shot('desktop-2x.png')

  await page.wheel(100, 2)
  await sleep(SETTLE)
  s = await page.state()
  check('Ctrl+wheel down zooms out, with the default prevented', s.level === '1×' && s.outOff && (await page.eval('window.__wheel')) === true, s)
  await page.shot('desktop-1x.png')
  await page.wheel(-100, 4)
  await sleep(SETTLE)
  check('⌘+wheel up zooms in', (await page.state()).level === '2×')
  await page.wheel(-100, 0)
  await sleep(200)
  check('a plain wheel is left alone', (await page.state()).level === '2×' && (await page.eval('window.__wheel')) === false)
  // A trackpad pinch: many small Ctrl+wheel deltas.
  for (let i = 0; i < 6; i++) {
    await page.wheel(-8, 2)
    await sleep(16)
  }
  await sleep(SETTLE)
  check('a trackpad pinch adds up to one step', (await page.state()).level === '3×')

  await page.key('+')
  await sleep(SETTLE)
  check('the + key zooms in', (await page.state()).level === '4×')
  await page.key('0')
  await sleep(SETTLE)
  s = await page.state()
  check('0 goes back to the default and forgets the pick', s.level === '3×' && s.saved === null && s.resetOff, s)

  await page.key('-')
  await sleep(SETTLE)
  await page.send('Page.reload')
  await page.until(`!document.getElementById('join').hidden`)
  await join(page, `Zoom-${run}`)
  s = await page.state()
  check('the pick survives a reload', s.level === '2×' && s.saved === '2' && !s.resetOff, s)
  await page.shot('desktop-2x-reloaded.png')

  // Typing in the chat: the keys are text, not zoom.
  await page.key('Enter')
  await page.until(`document.activeElement?.id === 'chat-input'`)
  await page.key('-')
  await page.key('+')
  await page.key('0')
  await sleep(200)
  const typed = await page.eval(`document.getElementById('chat-input').value`)
  check('the keys type in the chat instead of zooming', (await page.state()).level === '2×' && typed === '-+0', typed)
  await page.eval(`(() => { document.getElementById('chat-input').value = ''; document.activeElement.blur(); return true })()`)
  await page.key('Escape')
  await sleep(100)

  // The avatar editor holds the keyboard too.
  await page.click('avatar-edit')
  await page.until(`document.getElementById('avatar-editor').open`)
  await page.key('-')
  await page.key('0')
  await sleep(200)
  check('the keys do nothing while the editor is open', (await page.state()).level === '2×')
  await page.key('Escape')
  await page.until(`!document.getElementById('avatar-editor').open`)
  await page.eval('document.activeElement?.blur(), true')
  await page.key('+')
  await sleep(SETTLE)
  check('the keys work again once it closes', (await page.state()).level === '3×')

  // A pick holds across a resize within what the screen allows; the default follows.
  await page.key('+')
  await sleep(SETTLE)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  const narrow = await page.state()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  check('a pick of 4× shows as 3× on a phone-sized window and comes back', narrow.level === '3×' && (await page.state()).level === '4×', narrow)
  await page.key('0')
  await sleep(SETTLE)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  s = await page.state()
  check('the default follows the window: 4× at 1920×1080, 1× out of reach', s.level === '4×' && s.saved === null, s)
  await page.shot('desktop-1920-default.png')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(500)

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await page.click('zoom-in')
  await sleep(60)
  check('reduced motion: the zoom lands at once', (await page.state()).level === '4×')
  await page.shot('desktop-4x-dark.png')
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
  await page.shot('phone-3x.png')
  await page.click('zoom-out')
  await sleep(SETTLE)
  await page.click('zoom-out')
  await sleep(SETTLE)
  s = await page.state()
  check('two taps on − go to 1×', s.level === '1×' && s.outOff, s)
  await page.shot('phone-1x.png')

  await page.pinch(100, 260)
  await sleep(SETTLE)
  s = await page.state()
  check('a pinch out zooms in by its scale', s.level === '3×', s)
  await page.pinch(240, 150)
  await sleep(SETTLE)
  s = await page.state()
  check('a pinch in zooms out', s.level === '2×', s)
  const chatOpen = await page.eval(`!document.getElementById('chat-panel').hidden`)
  check('a pinch does not open anything', !chatOpen)

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(200)
  await page.shot('phone-2x-dark.png')

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
