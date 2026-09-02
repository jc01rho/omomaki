type OpencodeClientType = import('@opencode-ai/sdk/v2').OpencodeClient

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { setDataDir } from '../config.js'
import { closeDatabase, initDatabase } from '../database.js'
import { getDb } from '../db.js'
import * as schema from '../schema.js'
import {
  getOmoRpcOpencodeClient,
  restartOmoRpcRuntime,
} from './rpc-opencode-client.js'
import { setRpcSessionSpawnForTests, stopAllRpcSessions } from './rpc-session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'fake-rpc-server.mjs')
const TIMEOUT_MS = 2_000

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`timed out waiting for: ${label}`)),
        TIMEOUT_MS,
      )
    }),
  ])
}

afterEach(async () => {
  setRpcSessionSpawnForTests(undefined)
  await stopAllRpcSessions()
  await closeDatabase().catch(() => {})
})

describe('omo rpc opencode client shim', () => {
  test('command.list maps get_commands from classic rpc', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const client = getOmoRpcOpencodeClient(process.cwd())
    const listed = await withTimeout(client.command.list(), 'command.list')
    expect(listed.error).toBeUndefined()
    expect(listed.data).toEqual([
      {
        name: 'build',
        description: 'Build command',
        source: 'command',
        template: '/build $ARGUMENTS',
        hints: [],
      },
    ])
    await restartOmoRpcRuntime()
  })

  test('session.revert fails closed when no thread is bound to the session', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-revert-unbound-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const client = getOmoRpcOpencodeClient(process.cwd())
    const reverted = await withTimeout(
      client.session.revert({ sessionID: 'x', messageID: 'msg_1' }),
      'session.revert',
    )
    expect(reverted.data).toBeUndefined()
    expect(reverted.error).toBeTruthy()
    await restartOmoRpcRuntime()
  })

  test('session.revert issues navigate_tree over live omo rpc when a thread is bound', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-revert-bound-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const db = await getDb()
    await db
      .insert(schema.thread_sessions)
      .values({ thread_id: 'thread-revert-1', session_id: 'session-revert-1' })
      .onConflictDoNothing({ target: schema.thread_sessions.thread_id })

    const client = getOmoRpcOpencodeClient(process.cwd())
    const reverted = await withTimeout(
      client.session.revert({
        sessionID: 'session-revert-1',
        messageID: 'msg_1',
      }),
      'session.revert',
    )
    expect(reverted.error).toBeUndefined()
    expect(reverted.data?.id).toBe('session-revert-1')
    expect(reverted.data?.revert?.messageID).toBe('msg_1')
    await restartOmoRpcRuntime()
  })

  test('session.unrevert issues navigate_tree to the latest message over live omo rpc', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-unrevert-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const db = await getDb()
    await db
      .insert(schema.thread_sessions)
      .values({ thread_id: 'thread-unrevert-1', session_id: 'session-unrevert-1' })
      .onConflictDoNothing({ target: schema.thread_sessions.thread_id })

    const client = getOmoRpcOpencodeClient(process.cwd())
    const unrev = await withTimeout(
      client.session.unrevert({ sessionID: 'session-unrevert-1' }),
      'session.unrevert',
    )
    expect(unrev.error).toBeUndefined()
    expect(unrev.data?.id).toBe('session-unrevert-1')
    await restartOmoRpcRuntime()
  })

  test('mcp.status maps get_loaded_surfaces to a per-name status map', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-mcp-status-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const client = getOmoRpcOpencodeClient(process.cwd())
    const status = await withTimeout(client.mcp.status(), 'mcp.status')
    expect(status.error).toBeUndefined()
    expect(status.data).toEqual({
      'connected-server': { status: 'connected' },
      'enabled-server': { status: 'connected' },
      'disabled-server': { status: 'disabled' },
      'failed-server': { status: 'failed' },
    })
    await restartOmoRpcRuntime()
  })

  test('mcp.connect fails closed without booting an OpenCode server', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-mcp-connect-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const client = getOmoRpcOpencodeClient(process.cwd())
    const connected = await withTimeout(
      client.mcp.connect({ name: 'fake-mcp' }),
      'mcp.connect',
    )
    expect(connected.data).toBeUndefined()
    expect(connected.error).toBeTruthy()
    await restartOmoRpcRuntime()
  })

  test('revert persists the cursor so session.get exposes it (redo works)', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-revert-roundtrip-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const db = await getDb()
    await db
      .insert(schema.thread_sessions)
      .values({ thread_id: 'thread-revert-rt', session_id: 'session-revert-rt' })
      .onConflictDoNothing({ target: schema.thread_sessions.thread_id })

    const client = getOmoRpcOpencodeClient(process.cwd())
    const reverted = await withTimeout(
      client.session.revert({
        sessionID: 'session-revert-rt',
        messageID: 'msg_target',
      }),
      'session.revert',
    )
    expect(reverted.error).toBeUndefined()

    const fetched = await withTimeout(
      client.session.get({ sessionID: 'session-revert-rt' }),
      'session.get after revert',
    )
    expect(fetched.error).toBeUndefined()
    expect(fetched.data?.revert?.messageID).toBe('msg_target')

    const unrev = await withTimeout(
      client.session.unrevert({ sessionID: 'session-revert-rt' }),
      'session.unrevert',
    )
    expect(unrev.error).toBeUndefined()

    const afterUnrevert = await withTimeout(
      client.session.get({ sessionID: 'session-revert-rt' }),
      'session.get after unrevert',
    )
    expect(afterUnrevert.error).toBeUndefined()
    expect(afterUnrevert.data?.revert).toBeUndefined()
    await restartOmoRpcRuntime()
  })

  test('session.status reports busy when get_state isSettled is false', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-status-busy-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const db = await getDb()
    await db
      .insert(schema.thread_sessions)
      .values({ thread_id: 'thread-status-busy', session_id: 'session-status-busy' })
      .onConflictDoNothing({ target: schema.thread_sessions.thread_id })

    const client = getOmoRpcOpencodeClient(process.cwd())
    // Idle by default
    const statusParams = {
      sessionID: 'session-status-busy',
      directory: process.cwd(),
    } as Parameters<OpencodeClientType['session']['status']>[0]
    const idle = await withTimeout(
      client.session.status(statusParams),
      'session.status idle',
    )
    expect(idle.error).toBeUndefined()
    expect(idle.data?.['session-status-busy']?.type).toBe('idle')

    // Flip isSettled=false via a set_busy prompt routed through the same session
    await withTimeout(
      client.session.command({ sessionID: 'session-status-busy', command: 'set_busy' }),
      'set busy',
    ).catch(() => {})
    const busyStatus = await withTimeout(
      client.session.status(statusParams),
      'session.status busy',
    )
    expect(busyStatus.error).toBeUndefined()
    expect(busyStatus.data?.['session-status-busy']?.type).toBe('busy')
    await restartOmoRpcRuntime()
  })

  test('session.messages and session.status fail closed for an unbound session', async () => {
    const dataDir = path.join(
      process.cwd(),
      'tmp',
      `omo-rpc-shim-unbound-failclosed-${process.pid}`,
    )
    setDataDir(dataDir)
    await initDatabase()
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const client = getOmoRpcOpencodeClient(process.cwd())

    const messagesParams = {
      sessionID: 'no-such-session',
      directory: process.cwd(),
    } as Parameters<OpencodeClientType['session']['messages']>[0]
    await expect(
      withTimeout(client.session.messages(messagesParams), 'messages'),
    ).rejects.toThrow(/no thread bound/)
    const statusParams = {
      sessionID: 'no-such-session',
      directory: process.cwd(),
    } as Parameters<OpencodeClientType['session']['status']>[0]
    await expect(
      withTimeout(client.session.status(statusParams), 'status'),
    ).rejects.toThrow(/no thread bound/)
    await restartOmoRpcRuntime()
  })
})
