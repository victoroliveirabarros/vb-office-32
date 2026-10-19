// Development-only check that publisher permissions keep a modified client
// out of a meeting room (docs/livekit.md). Needs the server with LiveKit
// serving the harness built by e2e/vite.config.ts (or Vite dev), then:
//
//   node e2e/intruder.mjs [base URL, default http://localhost:8080]
//
// CHROME picks the browser binary and CDP_PORT the DevTools port.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://localhost:8080'
const port = Number(process.env.CDP_PORT ?? 9333)

// Tiles of maps/office.tmj: Sala 1 spans x 1–10, y 1–8, with its door at (6, 9).
const ANA = { x: 6, y: 6 }
const BIA = { x: 3, y: 3 }
const DOOR = { x: 6, y: 9 }
const INSIDE = { x: 6, y: 8 }
const HALL = { x: 6, y: 11 }

// Fresh names: the server keeps a returning identity where it was.
const run = Date.now().toString(36).slice(-5)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const profile = mkdtempSync(join(tmpdir(), 'vb-office-32-e2e-'))
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

class CDP {
  #id = 0
  #pending = new Map()

  constructor(ws) {
    this.ws = ws
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      const call = this.#pending.get(msg.id)
      if (!call) return
      this.#pending.delete(msg.id)
      if (msg.error) call.reject(new Error(msg.error.message))
      else call.resolve(msg.result)
    }
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

async function open(cdp, role, name) {
  const url = `${base}/e2e/intruder.html?role=${role}&name=${name}-${run}`
  const { targetId } = await cdp.send('Target.createTarget', { url })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = {
    name,
    async eval(expression, userGesture = false) {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId)
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
    events: (type) => page.eval(`e2e.events.filter((e) => e.type === ${JSON.stringify(type)})`),
    walk: (tile) => page.eval(`e2e.walkTo(${tile.x}, ${tile.y})`),
  }
  await page.until('window.e2e?.selfId')
  return page
}

const results = { checks: [], latencies: {} }
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail })
}
const firstAfter = (list, at, pred = () => true) => list.find((e) => e.at >= at && pred(e))

async function scenario(cdp) {
  const ana = await open(cdp, 'honest', 'Ana')
  await ana.walk(ANA)
  await ana.until(`e2e.link === 'connected' && e2e.zone === 'sala-1'`)
  const anaId = await ana.eval('e2e.selfId')
  await ana.eval('e2e.toggleCamera()')
  await ana.eval('e2e.toggleScreen()', true)
  const sharing = await ana.until('e2e.screen?.on && !e2e.screen.busy', 10_000).catch(() => false)
  check('honest client shares its screen in a meeting room', sharing)
  const sources = sharing ? 3 : 2

  const eve = await open(cdp, 'intruder', 'Eve')
  await eve.walk(DOOR)
  await eve.until(`e2e.link === 'connected'`)
  await eve.until(`e2e.publications().filter((p) => p.identity === ${JSON.stringify(anaId)}).length >= ${sources}`)
  await sleep(3_000)
  const eveId = await eve.eval('e2e.selfId')
  check('intruder at the door is not nearby', !(await ana.eval(`e2e.nearby.includes(${JSON.stringify(eveId)})`)))
  check('intruder at the door subscribes to nothing', (await eve.events('subscribed')).length === 0, await eve.events('subscribed'))
  // The SDK drops permission events that arrive while it is still joining,
  // so the publications are read directly.
  const seen = (await eve.eval('e2e.publications()')).filter((p) => p.identity === anaId)
  check(
    `intruder sees ${sources} tracks, all not_allowed and unsubscribed`,
    seen.length === sources && seen.every((p) => p.permission === 'not_allowed' && !p.subscribed),
    seen,
  )
  const outside = await eve.eval('e2e.inbound()')
  check('intruder at the door receives 0 bytes', outside.audio === 0 && outside.video === 0, outside)

  const bia = await open(cdp, 'honest', 'Bia')
  const biaStart = Date.now()
  await bia.walk(BIA)
  await bia.until(`e2e.events.some((e) => e.type === 'show' && e.source === 'microphone')`, 5_000)
  if (sharing) await bia.until(`e2e.events.some((e) => e.type === 'show' && e.source === 'screen')`, 5_000)
  const biaZone = firstAfter(await bia.events('zone'), biaStart, (e) => e.id === 'sala-1')
  const biaShows = await bia.events('show')
  results.latencies.honestEnter = {
    microphone: firstAfter(biaShows, 0, (e) => e.source === 'microphone').at - biaZone.at,
    screen: sharing ? firstAfter(biaShows, 0, (e) => e.source === 'screen').at - biaZone.at : null,
  }
  await sleep(3_000)
  const v0 = await bia.eval('e2e.video()')
  await sleep(5_000)
  const v1 = await bia.eval('e2e.video()')
  results.video = v1.map((v) => ({
    ...v,
    kbps: Math.round(((v.bytes - (v0.find((o) => o.id === v.id)?.bytes ?? v.bytes)) * 8) / 5 / 1000),
  }))
  const biaBytes = await bia.eval('e2e.inbound()')
  check('honest client in the room receives audio and video', biaBytes.audio > 0 && biaBytes.video > 0, biaBytes)

  const enterAt = Date.now()
  await eve.eval('window.samples = e2e.sample(3_000), 0')
  await eve.walk(INSIDE)
  for (const source of ['microphone', 'camera', ...(sharing ? ['screen_share'] : [])]) {
    await eve.until(
      `e2e.events.some((e) => e.type === 'subscribed' && e.at >= ${enterAt} && e.identity === ${JSON.stringify(anaId)} && e.source === '${source}')`,
      5_000,
    )
  }
  const eveZone = firstAfter(await eve.events('zone'), enterAt, (e) => e.id === 'sala-1')
  const anaNear = firstAfter(await ana.events('nearby'), enterAt, (e) => e.ids.includes(eveId))
  const subs = (await eve.events('subscribed')).filter((e) => e.identity === anaId)
  results.latencies.intruderEnter = Object.fromEntries(
    subs.map((e) => [e.source, { fromZone: e.at - eveZone.at, fromPublisherNearby: e.at - anaNear.at }]),
  )
  check('intruder inside the room subscribes', subs.length >= sources, subs)
  const enterSamples = await eve.eval('window.samples')
  const firstBytes = enterSamples.find((s) => s.audio > 0 || s.video > 0)
  results.latencies.intruderEnter.firstMedia = firstBytes ? firstBytes.at - eveZone.at : null

  const leaveAt = Date.now()
  await eve.eval('window.samples = e2e.sample(3_000), 0')
  await eve.walk(DOOR)
  await eve.until(
    `e2e.events.filter((e) => e.type === 'unsubscribed' && e.at >= ${leaveAt} && e.identity === ${JSON.stringify(anaId)}).length >= ${sources}`,
    5_000,
  )
  const eveOut = firstAfter(await eve.events('zone'), leaveAt, (e) => e.id === '')
  const unsubs = (await eve.events('unsubscribed')).filter((e) => e.at >= leaveAt && e.identity === anaId)
  results.latencies.intruderLeave = Object.fromEntries(unsubs.map((e) => [e.source, e.at - eveOut.at]))
  // Media stops when the bytes stop growing, before the SDK tears the tracks down.
  const samples = await eve.eval('window.samples')
  let lastGrowth = null
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].video > samples[i - 1].video || samples[i].audio > samples[i - 1].audio) lastGrowth = samples[i].at
  }
  results.latencies.intruderLeave.lastMedia = lastGrowth === null ? null : lastGrowth - eveOut.at
  const before = await eve.eval('e2e.inbound()')
  await sleep(2_000)
  const after = await eve.eval('e2e.inbound()')
  check('intruder back at the door stops receiving', after.audio <= before.audio && after.video <= before.video, { before, after })

  if (sharing) {
    const outAt = Date.now()
    await ana.walk(HALL)
    await ana.until('e2e.screen && !e2e.screen.on && !e2e.screen.busy', 5_000)
    await bia.until(`e2e.events.some((e) => e.type === 'hide' && e.source === 'screen' && e.at >= ${outAt})`, 5_000)
    const anaOut = firstAfter(await ana.events('zone'), outAt, (e) => e.id === '')
    const off = firstAfter(await ana.events('screen'), outAt, (e) => !e.on && !e.busy)
    results.latencies.shareStopsOnLeave = off.at - anaOut.at
    check('leaving the meeting room stops the share', true)
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
process.exit(failed ? 1 : 0)
