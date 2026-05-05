// Long-running drift smoke. Boots the LAN server, opens two headless Chrome
// pages, completes the host/join handshake, starts a round, then injects
// scripted key presses on both peers for ~30s while watching for any
// state-hash-mismatch events. Fails loud if either peer stops running or any
// mismatch fires. Complement to scripts/e2e-webrtc-smoke.ts, not a replacement.

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const serverPort = Number(process.env.PORT ?? 8794)
const cdpPort = Number(process.env.CDP_PORT ?? 9224)
const driftSeconds = Number(process.env.DRIFT_SECONDS ?? 30)
const baseUrl = `http://127.0.0.1:${serverPort}/`
const profileDir = join(tmpdir(), `oi-sving-chrome-long-${Date.now()}-${Math.random().toString(36).slice(2)}`)

type JsonObject = Record<string, unknown>

class CdpPage {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (err: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', evt => {
      const msg = JSON.parse(String(evt.data))
      if (typeof msg.id !== 'number') return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result ?? {})
    })
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpPage> {
    const ws = new WebSocket(webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true })
    })
    const page = new CdpPage(ws)
    await page.send('Runtime.enable')
    await page.send('Page.enable')
    return page
  }

  send(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async eval<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    const wrapped = result.result as { value?: T; description?: string; subtype?: string } | undefined
    if (wrapped?.subtype === 'error') throw new Error(wrapped.description ?? 'browser evaluation failed')
    return wrapped?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor<T>(label: string, fn: () => Promise<T | false | null | undefined>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await delay(100)
  }
  throw new Error(`${label} timed out${lastError ? `: ${String(lastError)}` : ''}`)
}

async function cdpJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}${path}`, init)
  if (!res.ok) throw new Error(`CDP ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function newPage(url: string): Promise<CdpPage> {
  const target = await cdpJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  return CdpPage.connect(target.webSocketDebuggerUrl)
}

const server = Bun.spawn({
  cmd: ['bun', 'run', 'server/signaling-server.ts'],
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(serverPort), BIND_HOST: '127.0.0.1' },
  stdout: 'pipe',
  stderr: 'pipe',
})

let chrome: ReturnType<typeof Bun.spawn> | null = null
let host: CdpPage | null = null
let joiner: CdpPage | null = null

async function pageState(page: CdpPage | null): Promise<unknown> {
  if (!page) return null
  return page.eval(`
    ({
      appReady: Boolean(window.OiSving?.Net),
      menuHidden: document.getElementById('layer-menu')?.classList.contains('hidden'),
      gameHidden: document.getElementById('layer-game')?.classList.contains('hidden'),
      roomCode: window.OiSving?.Net?.getRoomCode?.(),
      localIds: window.OiSving?.Net?.getLocalPlayerIds?.(),
      remoteIds: window.OiSving?.Net?.getRemotePlayerIds?.(),
      isRoundStarted: window.OiSving?.Game?.isRoundStarted,
      isRunning: window.OiSving?.Game?.isRunning,
      frame: window.OiSving?.Game?.CURRENT_FRAME_ID,
      runIntervalId: window.OiSving?.Game?.runIntervalId,
      mismatches: window.__driftMismatches ?? [],
    })
  `).catch(err => ({ error: String(err) }))
}

// Install a state-hash-mismatch listener on both pages. Mismatches accumulate
// in window.__driftMismatches so the harness can poll them between input ticks
// and at teardown.
async function installMismatchProbe(page: CdpPage): Promise<void> {
  await page.eval(`
    (() => {
      window.__driftMismatches = window.__driftMismatches ?? [];
      if (window.__driftProbeInstalled) return true;
      window.__driftProbeInstalled = true;
      OiSving.Net.on('state-hash-mismatch', (frameId, expected, actual) => {
        window.__driftMismatches.push({ frameId, expected, actual });
      });
      return true;
    })()
  `)
}

// keyLeft codes from OiSvingConfig: red=49, blue=66.
async function setKey(page: CdpPage, keyCode: number, down: boolean): Promise<void> {
  await page.eval(`
    (() => {
      if (!OiSving?.Game) return false;
      if (${down}) OiSving.Game.keysDown[${keyCode}] = true;
      else delete OiSving.Game.keysDown[${keyCode}];
      return true;
    })()
  `)
}

try {
  await waitFor('server /health', async () => {
    const res = await fetch(`${baseUrl}health`).catch(() => null)
    return res?.ok
  })

  await mkdir(profileDir, { recursive: true })
  chrome = Bun.spawn({
    cmd: [
      chromePath,
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  await waitFor('Chrome CDP', async () => {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null)
    return res?.ok
  })

  host = await newPage(baseUrl)
  joiner = await newPage(baseUrl)

  await Promise.all([host, joiner].map(page => waitFor('OiSving bootstrap', () => page.eval<boolean>(`
    Boolean(window.OiSving?.Net && !document.body.classList.contains('hidden'))
  `))))

  await installMismatchProbe(host)
  await installMismatchProbe(joiner)

  const code = await host.eval<string>(`
    (async () => {
      OiSving.Menu.activatePlayer('red');
      return await OiSving.Net.host();
    })()
  `)

  await joiner.eval(`
    (async () => {
      OiSving.Menu.activatePlayer('blue');
      await OiSving.Net.join(${JSON.stringify(code)});
      return true;
    })()
  `)

  await waitFor('host sees joiner roster', () => host!.eval<boolean>(`
    OiSving.Net.getRemotePlayerIds().includes('blue')
  `))
  await waitFor('joiner sees host roster', () => joiner!.eval<boolean>(`
    OiSving.Net.getRemotePlayerIds().includes('red')
  `))

  await delay(1_000)
  await host.eval(`OiSving.Menu.onSpaceDown(); true`)
  await waitFor('host enters game screen', () => host!.eval<boolean>(`
    !document.getElementById('layer-game').classList.contains('hidden')
    && OiSving.Game.curves.length === 2
  `))
  await host.eval(`OiSving.Game.onSpaceDown(); true`)
  await host.send('Page.bringToFront')

  await waitFor('host round running', () => host!.eval<boolean>(`
    OiSving.Game.isRoundStarted === true
    && (OiSving.Game.isRunning === true || OiSving.Game.runIntervalId !== null)
    && OiSving.Game.CURRENT_FRAME_ID > 0
  `), 8_000)
  await waitFor('joiner round running', () => joiner!.eval<boolean>(`
    OiSving.Game.isRoundStarted === true
    && (OiSving.Game.isRunning === true || OiSving.Game.runIntervalId !== null)
    && OiSving.Game.CURRENT_FRAME_ID > 0
  `), 8_000)

  // Drive both peers with a deterministic-feeling input pattern. Toggle each
  // peer's "left" key on a different cadence so curves keep swerving without
  // immediately running into each other or the wall. Round may end before
  // driftSeconds elapses (curves are short-lived); that's fine - we still
  // verify mismatch count is zero at teardown. Loop exits early if the round
  // ends, since no further drift can be measured once curves stop moving.
  const HOST_KEY_LEFT = 49 // '1'
  const JOINER_KEY_LEFT = 66 // 'b'
  const stepMs = 250
  const totalSteps = Math.max(1, Math.ceil((driftSeconds * 1_000) / stepMs))
  let stepsRun = 0
  let endedEarly = false

  for (let i = 0; i < totalSteps; i++) {
    const hostDown = (i % 4) < 2
    const joinerDown = (i % 6) < 3
    await setKey(host, HOST_KEY_LEFT, hostDown)
    await setKey(joiner, JOINER_KEY_LEFT, joinerDown)
    await delay(stepMs)
    stepsRun++

    if (i % 8 === 0) {
      const stillRunning = await host.eval<boolean>(`
        OiSving.Game.isRunning === true || OiSving.Game.runIntervalId !== null
      `).catch(() => false)
      if (!stillRunning) { endedEarly = true; break }
    }
  }

  // Release keys before reading final state.
  await setKey(host, HOST_KEY_LEFT, false)
  await setKey(joiner, JOINER_KEY_LEFT, false)

  const finalHost = await pageState(host) as Record<string, any>
  const finalJoiner = await pageState(joiner) as Record<string, any>

  const hostMismatches = (finalHost.mismatches ?? []) as unknown[]
  const joinerMismatches = (finalJoiner.mismatches ?? []) as unknown[]

  if (hostMismatches.length > 0 || joinerMismatches.length > 0) {
    throw new Error(`state-hash mismatch detected (host=${hostMismatches.length}, joiner=${joinerMismatches.length})`)
  }

  if (finalHost.frame === 0 || finalJoiner.frame === 0) {
    throw new Error(`peers never advanced past frame 0 (host=${finalHost.frame}, joiner=${finalJoiner.frame})`)
  }

  // State-hash gossip fires every stateHashIntervalFrames (default 60). If the
  // round ended before two intervals elapsed, the zero-mismatch result is
  // inconclusive — drift simply had no chance to surface. Treat that as a
  // failure so this script doesn't silently rubber-stamp regressions.
  const minMeaningfulFrames = 120
  const lowestFrame = Math.min(Number(finalHost.frame ?? 0), Number(finalJoiner.frame ?? 0))
  if (lowestFrame < minMeaningfulFrames) {
    throw new Error(`round ended before drift could be measured (lowest frame ${lowestFrame} < ${minMeaningfulFrames}); rerun with longer-surviving inputs or a longer DRIFT_SECONDS`)
  }

  console.log(JSON.stringify({
    ok: true,
    driftSeconds,
    stepsRun,
    endedEarly,
    hostFrame: finalHost.frame,
    joinerFrame: finalJoiner.frame,
    mismatches: { host: hostMismatches.length, joiner: joinerMismatches.length },
  }, null, 2))
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    error: String(err),
    hostState: await pageState(host),
    joinerState: await pageState(joiner),
  }, null, 2))
  throw err
} finally {
  host?.close()
  joiner?.close()
  chrome?.kill()
  server.kill()
  await server.exited.catch(() => {})
  if (chrome) await chrome.exited.catch(() => {})
  await rm(profileDir, { recursive: true, force: true })
}
