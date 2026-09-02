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
})
