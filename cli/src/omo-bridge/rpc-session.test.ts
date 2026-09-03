import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import {
  abortRpcSession,
  getOrStartRpcSession,
  RpcTransportDeadError,
  RpcTurnDeadlineError,
  setRpcSessionSpawnForTests,
  shouldUseOmoRpc,
  stopRpcSession,
} from './rpc-session.js'

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
  delete process.env['KIMAKI_RPC_TURN_DEADLINE_MS']
  await stopRpcSession('thread-rpc-session')
})

function writeCounter(value: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omomaki-rpc-counter-'))
  const file = path.join(dir, 'counter')
  fs.writeFileSync(file, String(value))
  return file
}

function waitForEvent(
  dispatched: OpenCodeEvent[],
  predicate: (event: OpenCodeEvent) => boolean,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (dispatched.some(predicate)) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(timer)
        reject(new Error(`did not observe ${label}`))
      }
    }, 10)
  })
}

describe('rpc session', () => {
  test('shouldUseOmoRpc is false under vitest unless KIMAKI_USE_OMO_RPC=1', () => {
    const previousOmoRpc = process.env['KIMAKI_USE_OMO_RPC']
    const previousVitest = process.env['KIMAKI_VITEST']
    delete process.env['KIMAKI_USE_OMO_RPC']
    process.env['KIMAKI_VITEST'] = '1'
    expect(shouldUseOmoRpc()).toBe(false)
    process.env['KIMAKI_USE_OMO_RPC'] = '1'
    expect(shouldUseOmoRpc()).toBe(true)
    if (previousOmoRpc === undefined) {
      delete process.env['KIMAKI_USE_OMO_RPC']
    } else {
      process.env['KIMAKI_USE_OMO_RPC'] = previousOmoRpc
    }
    if (previousVitest === undefined) {
      delete process.env['KIMAKI_VITEST']
    } else {
      process.env['KIMAKI_VITEST'] = previousVitest
    }
  })

  test('prompt dispatches RPC-OK-ONLY text part then idle', async () => {
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const dispatched: OpenCodeEvent[] = []
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async (event) => {
          dispatched.push(event)
        },
      }),
      'getOrStartRpcSession',
    )
    await withTimeout(
      session.prompt('reply with RPC-OK-ONLY', async (event) => {
        dispatched.push(event)
      }),
      'prompt',
    )
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const hasText = dispatched.some((event) => {
            return (
              event.type === 'message.part.updated' &&
              event.properties.part.type === 'text' &&
              event.properties.part.text.includes('RPC-OK-ONLY')
            )
          })
          const hasIdle = dispatched.some((event) => event.type === 'session.idle')
          if (hasText && hasIdle) {
            clearInterval(timer)
            resolve()
            return
          }
          if (Date.now() - started > TIMEOUT_MS) {
            clearInterval(timer)
            reject(new Error('did not observe RPC-OK-ONLY + idle'))
          }
        }, 10)
      }),
      'discord-shaped events',
    )
  })

  test('abort dispatches session.idle so the run is not left busy', async () => {
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const dispatched: OpenCodeEvent[] = []
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async (event) => {
          dispatched.push(event)
        },
      }),
      'getOrStartRpcSession',
    )
    const prompt = session.prompt('reply with RPC-OK-ONLY', async (event) => {
      dispatched.push(event)
    }).catch(() => {})
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const busy = dispatched.some((event) => {
            return (
              event.type === 'session.status' &&
              event.properties.status.type === 'busy'
            )
          })
          if (busy) {
            clearInterval(timer)
            resolve()
            return
          }
          if (Date.now() - started > TIMEOUT_MS) {
            clearInterval(timer)
            reject(new Error('did not observe busy'))
          }
        }, 10)
      }),
      'busy',
    )
    await withTimeout(abortRpcSession('thread-rpc-session'), 'abort')
    await prompt
    expect(dispatched.some((event) => event.type === 'session.idle')).toBe(true)
  })

  test('request get_commands returns slash commands from rpc', async () => {
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async () => {},
      }),
      'getOrStartRpcSession',
    )
    const data = await withTimeout(session.request('get_commands'), 'get_commands')
    expect(data).toEqual({
      commands: [{ name: 'build', description: 'Build command', source: 'prompt' }],
    })
  })

  test('deadline aborts a hung turn, settles the run, and kills the child', async () => {
    process.env['KIMAKI_RPC_TURN_DEADLINE_MS'] = '150'
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH],
    })
    const dispatched: OpenCodeEvent[] = []
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async (event) => {
          dispatched.push(event)
        },
      }),
      'getOrStartRpcSession',
    )
    const promptPromise = session
      .prompt('hang-forever', async (event) => {
        dispatched.push(event)
      })
      .catch((error: unknown) => error)
    const deadlineError = (await withTimeout(promptPromise, 'deadline turn')) as Error
    expect(deadlineError).toBeInstanceOf(RpcTurnDeadlineError)
    // The run must be settled so the Discord thread is not left busy forever.
    await withTimeout(
      waitForEvent(
        dispatched,
        (event) => event.type === 'session.idle',
        'idle after deadline abort',
      ),
      'idle after deadline abort',
    )
  })

  test('mid-turn child death is retried once and the turn completes', async () => {
    const crashCounter = writeCounter(1)
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH, crashCounter],
    })
    const dispatched: OpenCodeEvent[] = []
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async (event) => {
          dispatched.push(event)
        },
      }),
      'getOrStartRpcSession',
    )
    await withTimeout(
      session.prompt('reply with RPC-OK-ONLY then crash-mid-turn', async (event) => {
        dispatched.push(event)
      }),
      'retried turn',
    )
    await withTimeout(
      waitForEvent(
        dispatched,
        (event) =>
          event.type === 'message.part.updated' &&
          event.properties.part.type === 'text' &&
          String(event.properties.part.text).includes('RPC-OK-ONLY'),
        'retried turn text',
      ),
      'retried turn text',
    )
    await withTimeout(
      waitForEvent(dispatched, (event) => event.type === 'session.idle', 'retried idle'),
      'retried idle',
    )
  })

  test('second mid-turn child death surfaces RpcTransportDeadError and settles the run', async () => {
    const crashCounter = writeCounter(99)
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH, crashCounter],
    })
    const dispatched: OpenCodeEvent[] = []
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async (event) => {
          dispatched.push(event)
        },
      }),
      'getOrStartRpcSession',
    )
    const promptPromise = session
      .prompt('reply with RPC-OK-ONLY then crash-mid-turn', async (event) => {
        dispatched.push(event)
      })
      .catch((error: unknown) => error)
    const promptError = (await withTimeout(promptPromise, 'double crash turn')) as Error
    expect(promptError).toBeInstanceOf(RpcTransportDeadError)
    await withTimeout(
      waitForEvent(dispatched, (event) => event.type === 'session.idle', 'double crash idle'),
      'double crash idle',
    )
  })

  test('startup death quarantines the session file and starts a fresh session', async () => {
    const startupCounter = writeCounter(1)
    setRpcSessionSpawnForTests({
      command: process.execPath,
      args: [FIXTURE_PATH, writeCounter(0), startupCounter],
    })
    const dispatched: OpenCodeEvent[] = []
    const session = await withTimeout(
      getOrStartRpcSession({
        threadId: 'thread-rpc-session',
        cwd: process.cwd(),
        dispatch: async (event) => {
          dispatched.push(event)
        },
      }),
      'getOrStartRpcSession with startup death',
    )
    // The fallback must land on a working session, not surface the death.
    await withTimeout(
      session.prompt('reply with RPC-OK-ONLY', async (event) => {
        dispatched.push(event)
      }),
      'fallback turn',
    )
    await withTimeout(
      waitForEvent(
        dispatched,
        (event) =>
          event.type === 'message.part.updated' &&
          event.properties.part.type === 'text' &&
          String(event.properties.part.text).includes('RPC-OK-ONLY'),
        'fallback turn text',
      ),
      'fallback turn text',
    )
  })
})
