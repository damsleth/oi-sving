import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const serverPort = Number(process.env.PORT ?? 8793)
const cdpPort = Number(process.env.CDP_PORT ?? 9223)
const baseUrl = `http://127.0.0.1:${serverPort}/`
const profileDir = join(tmpdir(), `oi-sving-chrome-${Date.now()}-${Math.random().toString(36).slice(2)}`)

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
      curves: window.OiSving?.Game?.curves?.map(c => ({ id: c.getPlayer().getId(), local: c.getPlayer().isLocal })),
      players: window.OiSving?.Game?.players?.map(p => ({ id: p.getId(), local: p.isLocal })),
      isRoundStarted: window.OiSving?.Game?.isRoundStarted,
      isRunning: window.OiSving?.Game?.isRunning,
      frame: window.OiSving?.Game?.CURRENT_FRAME_ID,
      runIntervalId: window.OiSving?.Game?.runIntervalId,
      netStatus: document.getElementById('net-status')?.innerText,
    })
  `).catch(err => ({ error: String(err) }))
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
  await waitFor('host enters game screen', () => host!.eval<any>(`
    ({
      layerVisible: !document.getElementById('layer-game').classList.contains('hidden'),
      curves: OiSving.Game.curves.map(c => ({ id: c.getPlayer().getId(), local: c.getPlayer().isLocal }))
    })
  `).then(state => state.layerVisible && state.curves.length === 2 ? state : false))
  await host.eval(`OiSving.Game.onSpaceDown(); true`)
  await host.send('Page.bringToFront')

  const hostState = await waitFor('host game starts', () => host!.eval<any>(`
    ({
      layerVisible: !document.getElementById('layer-game').classList.contains('hidden'),
      started: OiSving.Game.isRoundStarted === true,
      running: OiSving.Game.isRunning === true || OiSving.Game.runIntervalId !== null,
      frame: OiSving.Game.CURRENT_FRAME_ID,
      curves: OiSving.Game.curves.map(c => ({ id: c.getPlayer().getId(), local: c.getPlayer().isLocal }))
    })
  `).then(state => state.layerVisible && state.started && state.running && state.frame > 0 && state.curves.length === 2 ? state : false), 8_000)

  await joiner.send('Page.bringToFront')
  const joinerState = await waitFor('joiner game starts from round-start', () => joiner!.eval<any>(`
    ({
      layerVisible: !document.getElementById('layer-game').classList.contains('hidden'),
      started: OiSving.Game.isRoundStarted === true,
      running: OiSving.Game.isRunning === true || OiSving.Game.runIntervalId !== null,
      frame: OiSving.Game.CURRENT_FRAME_ID,
      curves: OiSving.Game.curves.map(c => ({ id: c.getPlayer().getId(), local: c.getPlayer().isLocal }))
    })
  `).then(state => state.layerVisible && state.started && state.running && state.frame > 0 && state.curves.length === 2 ? state : false), 8_000)

  console.log(JSON.stringify({ ok: true, code, hostState, joinerState }, null, 2))
  await teardown(0)
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    error: String(err),
    hostState: await pageState(host),
    joinerState: await pageState(joiner),
  }, null, 2))
  await teardown(1)
}

async function killProcess(proc: ReturnType<typeof Bun.spawn> | null): Promise<void> {
  if (!proc) return
  try { proc.kill() } catch { /* */ }
  const settled = await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    delay(2000).then(() => false),
  ])
  if (!settled) {
    try { proc.kill('SIGKILL') } catch { /* */ }
    await proc.exited.catch(() => {})
  }
}

async function teardown(exitCode: number): Promise<void> {
  // Close CDP page WebSockets first so their event loops release.
  // Then kill Chrome + signaling server with a hard fallback after a
  // 2s grace window — kill() is graceful and Chrome can wedge if a
  // page has any pending operations. Without the SIGKILL fallback the
  // script printed "ok" and then hung indefinitely waiting on
  // process.exited.
  try { host?.close() } catch { /* */ }
  try { joiner?.close() } catch { /* */ }
  await delay(50)
  await killProcess(chrome)
  await killProcess(server as unknown as ReturnType<typeof Bun.spawn>)
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  process.exit(exitCode)
}
