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

export type RpcSessionHandle = {
  readonly sessionId: string
  prompt(
    text: string,
    dispatchNow: (event: OpenCodeEvent) => Promise<void>,
  ): Promise<void>
  abort(): Promise<void>
  stop(): Promise<void>
}

export type RpcSessionHost = {
  readonly threadId: string
  readonly cwd: string
  dispatch(event: OpenCodeEvent): Promise<void>
}

type LiveSession = {
  readonly client: OmoRpcClient
  readonly sessionId: string
  adapter: RpcTurnAdapter
  host: RpcSessionHost
  dispatchChain: Promise<void>
}

const sessions = new Map<string, LiveSession>()

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
  return process.env['KIMAKI_VITEST'] !== '1'
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
      await live.client.prompt(text)
      await live.dispatchChain
    },
    async abort(): Promise<void> {
      await live.client.stop()
      sessions.delete(threadId)
    },
    async stop(): Promise<void> {
      await live.client.stop()
      sessions.delete(threadId)
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
  return createHandle(live, host.threadId)
}

export async function stopRpcSession(threadId: string): Promise<void> {
  const existing = sessions.get(threadId)
  if (existing === undefined) {
    return
  }
  await existing.client.stop()
  sessions.delete(threadId)
}

export async function abortRpcSession(threadId: string): Promise<void> {
  await stopRpcSession(threadId)
}

export async function stopAllRpcSessions(): Promise<void> {
  const threadIds = [...sessions.keys()]
  for (const threadId of threadIds) {
    await stopRpcSession(threadId)
  }
}
