import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { setDataDir } from '../config.js'
import { closeDatabase, initDatabase } from '../database.js'
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
})
