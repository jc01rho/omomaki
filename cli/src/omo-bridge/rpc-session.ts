import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { getDataDir } from '../config.js'
import { createLogger, LogPrefix } from '../logger.js'
import { OmoRpcClient } from './rpc-client.js'
import {
  createRpcTurnAdapter,
  type RpcTurnAdapter,
} from './rpc-event-adapter.js'

const logger = createLogger(LogPrefix.SESSION)

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
  readonly client: OmoRpcClient
  readonly sessionId: string
  adapter: RpcTurnAdapter
  host: RpcSessionHost
  dispatchChain: Promise<void>
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
      try {
        await live.client.prompt(text)
        await live.client.waitForSettled()
      } catch {
        // Abort/stop rejects in-flight waiters; idle was already synthesized.
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

  const client = new OmoRpcClient({
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
    client,
    sessionId,
    adapter: createRpcTurnAdapter(sessionId),
    host,
    dispatchChain: Promise.resolve(),
  }
  liveBox.current = live

  await client.start()
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
