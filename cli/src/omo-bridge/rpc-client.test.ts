// Unit tests for OmoRpcClient against a fake classic omo --mode rpc child.
// All async waits are bounded via Promise.race — no fixed sleeps.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { OmoRpcClient } from './rpc-client.js'

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

const clients: OmoRpcClient[] = []

function makeClient(
  overrides: ConstructorParameters<typeof OmoRpcClient>[0] = {},
) {
  const client = new OmoRpcClient({
    command: process.execPath,
    args: [FIXTURE_PATH],
    stderr: () => {},
    ...overrides,
  })
  clients.push(client)
  return client
}

afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop()!
    await client.stop().catch(() => {})
  }
})

describe('OmoRpcClient', () => {
  test('rejects --listen including stdio:// (classic process stdio only)', () => {
    expect(
      () =>
        new OmoRpcClient({
          args: ['--mode', 'rpc', '--listen', 'unix:///tmp/omo.sock'],
        }),
    ).toThrow(/listen/)
    expect(
      () =>
        new OmoRpcClient({
          args: ['--mode', 'rpc', '--listen', 'stdio://'],
        }),
    ).toThrow(/listen/)
  })

  test('injects --no-extensions and -e omomaki-approve.ts for omo command', () => {
    const client = new OmoRpcClient({
      command: 'omo',
      args: ['--mode', 'rpc', '--session', '/tmp/s.jsonl'],
    })
    const args = client.getSpawnArgs()
    expect(args).toContain('--no-extensions')
    const extIndex = args.indexOf('-e')
    expect(extIndex).toBeGreaterThan(-1)
    expect(args[extIndex + 1]).toMatch(/omomaki-approve\.ts$/)
    expect(args.join(' ')).not.toMatch(/\.omo\/agent\/extensions/)
  })

  test('does not inject extension flags for non-omo fixtures', () => {
    const client = makeClient()
    expect(client.getSpawnArgs()).toEqual([FIXTURE_PATH])
  })

  test('rejects --multi-session (classic --session only)', () => {
    expect(
      () =>
        new OmoRpcClient({
          args: ['--mode', 'rpc', '--multi-session'],
        }),
    ).toThrow(/classic/)
  })

  test('prompt streams RPC-OK-ONLY then agent_settled', async () => {
    const events: Array<{ type: string }> = []
    const client = makeClient({
      onEvent: (event) => {
        events.push(event)
      },
    })
    await withTimeout(client.start(), 'start()')
    await withTimeout(client.prompt('reply with RPC-OK-ONLY'), 'prompt()')
    await withTimeout(client.waitForSettled(), 'waitForSettled()')
    const types = events.map((event) => event.type)
    expect(types).toContain('text_delta')
    expect(types).toContain('agent_settled')
    const deltas = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => ('delta' in event ? String(event.delta) : ''))
      .join('')
    expect(deltas).toContain('RPC-OK-ONLY')
  })

  test('confirm request is answered fail-closed as confirmed:false', async () => {
    const requests: Array<{ id: string; method: string }> = []
    const client = makeClient({
      onExtensionUiRequest: (request) => {
        requests.push(request)
      },
    })
    await withTimeout(client.start(), 'start()')
    const prompt = client.prompt('please touch-denied the file')
    await withTimeout(
      new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (requests.length > 0) {
            clearInterval(interval)
            resolve()
          }
        }, 10)
      }),
      'extension_ui_request',
    )
    expect(requests[0]?.method).toBe('confirm')
    await withTimeout(
      client.respondToExtensionUi(requests[0]!.id, { confirmed: false }),
      'respondToExtensionUi',
    )
    await withTimeout(prompt, 'prompt after deny')
    await withTimeout(client.waitForSettled(), 'settled after deny')
  })

  test('request returns response data for get_commands', async () => {
    const client = makeClient()
    await withTimeout(client.start(), 'start()')
    const data = await withTimeout(
      client.request('get_commands'),
      'get_commands',
    )
    expect(data).toEqual({
      commands: [{ name: 'build', description: 'Build command', source: 'prompt' }],
    })
  })
})
