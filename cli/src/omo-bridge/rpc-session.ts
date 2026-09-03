import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { getDataDir } from '../config.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  OmoRpcClient,
  OmoRpcClientExitedError,
} from './rpc-client.js'
import {
  createRpcTurnAdapter,
  type RpcTurnAdapter,
} from './rpc-event-adapter.js'

const logger = createLogger(LogPrefix.SESSION)

/**
 * Whole-turn deadline (ms), ported from omon-gateway's total_timeout: an
 * agent stuck in a loop keeps emitting events, so an event-gap timeout never
 * fires. On deadline we send abort, then stop the child (SIGTERM -> SIGKILL)
 * so neither the Discord thread nor the process can be occupied forever.
 * Override with KIMAKI_RPC_TURN_DEADLINE_MS.
 */
const DEFAULT_TURN_DEADLINE_MS = 15 * 60 * 1000

function resolveTurnDeadlineMs(): number {
  const raw = process.env['KIMAKI_RPC_TURN_DEADLINE_MS']
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TURN_DEADLINE_MS
  }
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `invalid KIMAKI_RPC_TURN_DEADLINE_MS '${raw}', falling back to ${DEFAULT_TURN_DEADLINE_MS}`,
    )
    return DEFAULT_TURN_DEADLINE_MS
  }
  return parsed
}

/** Probe window for the startup liveness check (get_protocol_info roundtrip). */
const RPC_STARTUP_PROBE_TIMEOUT_MS = 15_000

export type RpcSessionSpawn = {
  readonly command: string
  readonly args: readonly string[]
}

export type RpcExtensionUiRequest = {
  readonly id: string
  readonly method: string
  readonly title?: string
  readonly message?: string
  readonly timeout?: number
}

export type RpcSessionHandle = {
  readonly sessionId: string
  prompt(
    text: string,
    dispatchNow: (event: OpenCodeEvent) => Promise<void>,
  ): Promise<void>
  request(
    type: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>
  abort(): Promise<void>
  stop(): Promise<void>
}

export type RpcSessionHost = {
  readonly threadId: string
  readonly cwd: string
  dispatch(event: OpenCodeEvent): Promise<void>
  onExtensionUiRequest?(request: RpcExtensionUiRequest): void
}

type LiveSession = {
  client: OmoRpcClient
  readonly sessionId: string
  adapter: RpcTurnAdapter
  host: RpcSessionHost
  dispatchChain: Promise<void>
  createClient(): OmoRpcClient
  /** Set after the one-shot mid-turn transport retry, ported from omon-gateway. */
  transportRetried: boolean
}

/**
 * Transport-level failure of the RPC child mid-turn (crash, SIGKILL, EPIPE).
 * Retryable by design: the durable --session file keeps the conversation, so
 * respawning a fresh child resumes where the previous one died.
 */
export class RpcTransportDeadError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`omo rpc transport died: ${reason}`)
    this.name = 'RpcTransportDeadError'
  }
}

/**
 * Raised when a turn outlives the whole-turn deadline. Mirrors
 * omon-gateway's "turn exceeded total deadline" error.
 */
export class RpcTurnDeadlineError extends Error {
  readonly deadlineMs: number
  constructor(deadlineMs: number) {
    super(`omo rpc turn exceeded deadline of ${deadlineMs}ms; abort was sent`)
    this.name = 'RpcTurnDeadlineError'
    this.deadlineMs = deadlineMs
  }
}

const sessions = new Map<string, LiveSession>()
const sessionIdToThreadId = new Map<string, string>()

let spawnOverride: RpcSessionSpawn | undefined

export function setRpcSessionSpawnForTests(
  spawn: RpcSessionSpawn | undefined,
): void {
  spawnOverride = spawn
}

export function shouldUseOmoRpc(): boolean {
  if (process.env['KIMAKI_USE_OPENCODE'] === '1') {
    return false
  }
  if (process.env['KIMAKI_USE_OMO_RPC'] === '1') {
    return true
  }
  // 프로덕션 기본값은 클래식 omo RPC다. vitest 하네스만 KIMAKI_VITEST=1
  // (cli/vitest.config.ts) 를 주입하고, 위의 명시적 플래그가 없을 경우에만
  // OpenCode 경로로 분기한다.
  if (process.env['KIMAKI_VITEST'] === '1') {
    return false
  }
  return true
}

function sessionFileFor(threadId: string): string {
  const dir = path.join(getDataDir(), 'omo-sessions')
  fs.mkdirSync(dir, { recursive: true })
  const safe = threadId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(dir, `${safe}.jsonl`)
}

function resolveSpawn(cwd: string, sessionFile: string): RpcSessionSpawn {
  if (spawnOverride !== undefined) {
    return spawnOverride
  }
  return {
    command: 'omo',
    args: [
      '--mode',
      'rpc',
      '--session',
      sessionFile,
      '--session-dir',
      cwd,
    ],
  }
}

function eventId(): string {
  return `evt_${crypto.randomUUID()}`
}

function permissionAskedEvent(opts: {
  sessionId: string
  request: RpcExtensionUiRequest
}): OpenCodeEvent {
  const message = opts.request.message ?? opts.request.title ?? 'tool'
  return {
    id: eventId(),
    type: 'permission.asked',
    properties: {
      id: opts.request.id,
      sessionID: opts.sessionId,
      permission: opts.request.method || 'confirm',
      patterns: [message],
      metadata: {
        title: opts.request.title,
        message: opts.request.message,
      },
      always: [],
    },
  }
}

async function dispatchEvents(
  live: LiveSession,
  events: readonly OpenCodeEvent[],
): Promise<void> {
  live.dispatchChain = live.dispatchChain.then(async () => {
    for (const next of events) {
      await live.host.dispatch(next)
    }
  })
  await live.dispatchChain
}

function forgetSession(threadId: string, sessionId: string): void {
  sessions.delete(threadId)
  sessionIdToThreadId.delete(sessionId)
}

async function stopLiveSession(live: LiveSession, threadId: string): Promise<void> {
  const aborted = live.adapter.abort(Date.now())
  await dispatchEvents(live, aborted).catch(() => {})
  await live.client.stop()
  forgetSession(threadId, live.sessionId)
}

/**
 * Maps low-level transport failures onto {@link RpcTransportDeadError}.
 * Deliberate stop/abort rejections ("omo rpc client stopped") are NOT
 * transport deaths and return null so they keep the existing swallow
 * semantics (idle was already synthesized by the abort path).
 */
function asTransportDead(error: unknown): RpcTransportDeadError | null {
  if (error instanceof RpcTransportDeadError) {
    return error
  }
  if (error instanceof OmoRpcClientExitedError) {
    return new RpcTransportDeadError(error)
  }
  if (error instanceof Error) {
    if (
      error.message.includes('omo rpc client exited unexpectedly') ||
      error.message.includes('client stdin is not writable')
    ) {
      return new RpcTransportDeadError(error)
    }
  }
  return null
}

/**
 * Runs one prompt turn bounded by the whole-turn deadline. Ported from
 * omon-gateway's total_timeout flow: on deadline, synthesize idle so the
 * Discord run settles, send abort best-effort (the child may be wedged and
 * never answer), then drop the transport; stop() escalates SIGTERM to
 * SIGKILL after a short grace.
 */
async function runTurnWithDeadline(
  live: LiveSession,
  text: string,
  deadlineMs: number,
): Promise<void> {
  let deadlineTimer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new RpcTurnDeadlineError(deadlineMs)),
      deadlineMs,
    )
  })
  // Mark the rejection as handled so a turn that ends (or dies) before the
  // race is even created cannot crash the process via unhandled rejection.
  deadline.catch(() => {})
  try {
    await live.client.prompt(text)
    await Promise.race([live.client.waitForSettled(), deadline])
  } catch (error) {
    if (error instanceof RpcTurnDeadlineError) {
      await dispatchEvents(live, live.adapter.abort(Date.now())).catch(() => {})
      await live.client.request('abort').catch(() => {})
      await live.client.stop().catch(() => {})
    }
    throw error
  } finally {
    clearTimeout(deadlineTimer)
  }
}

/**
 * Ported from omon-gateway's one-shot retry: when the transport dies
 * mid-turn, respawn a fresh child (the durable --session file preserves the
 * conversation) and re-prompt once. The turn adapter is NOT restarted, so no
 * duplicate busy/userMessage events are dispatched to Discord. On a second
 * transport death the run is settled with synthesized idle and the error
 * surfaces to the runtime.
 */
async function recoverTransportDeath(
  live: LiveSession,
  text: string,
  deadlineMs: number,
  threadId: string,
  error: RpcTransportDeadError,
): Promise<void> {
  if (live.transportRetried) {
    await dispatchEvents(live, live.adapter.abort(Date.now())).catch(() => {})
    await live.client.stop().catch(() => {})
    forgetSession(threadId, live.sessionId)
    throw error
  }  live.transportRetried = true
  logger.warn(`omo rpc child died mid-turn; retrying once (${error.message})`)
  await live.client.stop().catch(() => {})
  const client = live.createClient()
  await client.start()
  live.client = client
  try {
    await runTurnWithDeadline(live, text, deadlineMs)
  } catch (retryError) {
    if (retryError instanceof RpcTurnDeadlineError) {
      forgetSession(threadId, live.sessionId)
      throw retryError
    }
    const retryDead = asTransportDead(retryError)
    if (retryDead !== null) {
      // Second transport death within one turn: the one-shot retry budget is
      // spent. Settle the run with synthesized idle so Discord is not left
      // busy, then surface the error to the runtime.
      await dispatchEvents(live, live.adapter.abort(Date.now())).catch(() => {})
      await live.client.stop().catch(() => {})
      forgetSession(threadId, live.sessionId)
      throw retryDead
    }
    throw retryError
  }
}

function createHandle(live: LiveSession, threadId: string): RpcSessionHandle {
  return {
    sessionId: live.sessionId,
    async prompt(
      text: string,
      dispatchNow: (event: OpenCodeEvent) => Promise<void>,
    ): Promise<void> {
      live.adapter = createRpcTurnAdapter(live.sessionId)
      const started = live.adapter.startTurn(text, Date.now())
      live.dispatchChain = live.dispatchChain.then(async () => {
        for (const next of started) {
          await dispatchNow(next)
        }
      })
      await live.dispatchChain
      const deadlineMs = resolveTurnDeadlineMs()
      try {
        await runTurnWithDeadline(live, text, deadlineMs)
      } catch (error) {
        if (error instanceof RpcTurnDeadlineError) {
          // runTurnWithDeadline already synthesized idle, aborted, and
          // stopped the child; forget the session so the next turn spawns
          // a fresh child instead of writing into a dead transport.
          forgetSession(threadId, live.sessionId)
          throw error
        }
        const transportDead = asTransportDead(error)
        if (transportDead !== null) {
          await recoverTransportDeath(
            live,
            text,
            deadlineMs,
            threadId,
            transportDead,
          )
        }
        // Otherwise the rejection came from a deliberate abort/stop; idle
        // was already synthesized by the abort path.
      }
      await live.dispatchChain
    },
    async request(
      type: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> {
      return live.client.request(type, params)
    },
    async abort(): Promise<void> {
      await stopLiveSession(live, threadId)
    },
    async stop(): Promise<void> {
      await live.client.stop()
      forgetSession(threadId, live.sessionId)
    },
  }
}

/**
 * Ported from omon-gateway's thread/resume fallback: when the RPC child dies
 * during startup, the durable session file is most likely corrupt or
 * unreadable (probe-verified behavior: omo exits with "Session file is not a
 * valid OmO session"). Quarantine the file (rename, never delete) and start
 * a fresh session on the same thread so one bad rollout file cannot wedge
 * the thread forever.
 */
function isStartupDeath(error: unknown): boolean {
  if (error instanceof OmoRpcClientExitedError) {
    return true
  }
  return (
    error instanceof Error &&
    error.message.includes('client stdin is not writable')
  )
}

function quarantineSessionFile(sessionFile: string): void {
  const quarantined = `${sessionFile}.corrupt-${Date.now()}`
  try {
    fs.renameSync(sessionFile, quarantined)
  } catch {
    // Best effort: if the rename fails the fresh child will fail loudly on
    // the next start instead of silently looping on a bad file.
  }
}

async function probeRpcAlive(client: OmoRpcClient): Promise<void> {
  let probeTimer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    probeTimer = setTimeout(
      () => reject(new Error('omo rpc startup probe timed out')),
      RPC_STARTUP_PROBE_TIMEOUT_MS,
    )
  })
  timeout.catch(() => {})
  try {
    await Promise.race([
      client.request('get_protocol_info'),
      timeout,
    ])
  } finally {
    clearTimeout(probeTimer)
  }
}

async function startLiveSession(
  live: LiveSession,
  sessionFile: string,
): Promise<void> {
  try {
    await live.client.start()
    await probeRpcAlive(live.client)
    return
  } catch (error) {
    if (!isStartupDeath(error)) {
      throw error
    }
    logger.warn(
      `omo rpc child died during startup; quarantining session file and starting fresh (${String(error)})`,
    )
    quarantineSessionFile(sessionFile)
    const freshClient = live.createClient()
    await freshClient.start()
    await probeRpcAlive(freshClient)
    live.client = freshClient
  }
}

export async function getOrStartRpcSession(
  host: RpcSessionHost,
): Promise<RpcSessionHandle> {
  const existing = sessions.get(host.threadId)
  if (existing !== undefined) {
    existing.host = host
    return createHandle(existing, host.threadId)
  }

  const sessionId = `omo_${crypto.randomUUID()}`
  const sessionFile = sessionFileFor(host.threadId)
  const spawn = resolveSpawn(host.cwd, sessionFile)
  const liveBox: { current: LiveSession | undefined } = { current: undefined }

  const createClient = (): OmoRpcClient =>
    new OmoRpcClient({
      command: spawn.command,
      args: [...spawn.args],
      cwd: host.cwd,
      stderr: (line) => {
        logger.log(`[OMO RPC] ${line}`)
      },
      onEvent: (event) => {
        const live = liveBox.current
        if (live === undefined) {
          return
        }
        const synthesized = live.adapter.feed(event, Date.now())
        live.dispatchChain = live.dispatchChain.then(async () => {
          for (const next of synthesized) {
            await live.host.dispatch(next)
          }
        })
      },
      onExtensionUiRequest: (request) => {
        const live = liveBox.current
        if (live === undefined) {
          return
        }
        const asked = permissionAskedEvent({
          sessionId: live.sessionId,
          request,
        })
        live.dispatchChain = live.dispatchChain.then(async () => {
          await live.host.dispatch(asked)
        })
        live.host.onExtensionUiRequest?.(request)
      },
    })

  const live: LiveSession = {
    client: createClient(),
    sessionId,
    adapter: createRpcTurnAdapter(sessionId),
    host,
    dispatchChain: Promise.resolve(),
    createClient,
    transportRetried: false,
  }
  liveBox.current = live

  await startLiveSession(live, sessionFile)
  sessions.set(host.threadId, live)
  sessionIdToThreadId.set(sessionId, host.threadId)
  return createHandle(live, host.threadId)
}

export async function stopRpcSession(threadId: string): Promise<void> {
  const existing = sessions.get(threadId)
  if (existing === undefined) {
    return
  }
  await existing.client.stop()
  forgetSession(threadId, existing.sessionId)
}

export async function abortRpcSession(threadId: string): Promise<void> {
  const existing = sessions.get(threadId)
  if (existing === undefined) {
    return
  }
  await stopLiveSession(existing, threadId)
}

export async function respondToRpcExtensionUi(opts: {
  sessionId: string
  requestId: string
  confirmed: boolean
}): Promise<boolean> {
  const threadId = sessionIdToThreadId.get(opts.sessionId)
  if (threadId === undefined) {
    return false
  }
  const live = sessions.get(threadId)
  if (live === undefined) {
    return false
  }
  await live.client.respondToExtensionUi(opts.requestId, {
    confirmed: opts.confirmed,
  })
  return true
}

export async function stopAllRpcSessions(): Promise<void> {
  const threadIds = [...sessions.keys()]
  for (const threadId of threadIds) {
    await stopRpcSession(threadId)
  }
}

export function getLiveRpcClient(threadId: string): OmoRpcClient | null {
  return sessions.get(threadId)?.client ?? null
}

export function sessionFileForThread(threadId: string): string {
  return sessionFileFor(threadId)
}
