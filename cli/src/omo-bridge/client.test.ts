// Unit tests for OmoAppServerClient against a fake app-server child process
// (see __fixtures__/fake-app-server.mjs). All async waits are bounded via
// Promise.race with a timeout — no fixed sleeps.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { OmoAppServerClient } from './client.js'
import type {
  ApprovalServerRequest,
  JsonRpcNotification,
} from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(
  __dirname,
  '__fixtures__',
  'fake-app-server.mjs',
)

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

function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        try {
          if (predicate()) {
            clearInterval(interval)
            resolve()
          }
        } catch (error) {
          clearInterval(interval)
          reject(error as Error)
        }
      }, 10)
    }),
    label,
  )
}

const clients: OmoAppServerClient[] = []

function makeClient(
  overrides: ConstructorParameters<typeof OmoAppServerClient>[0] = {},
) {
  const client = new OmoAppServerClient({
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
    await client.shutdown().catch(() => {})
  }
})

describe('OmoAppServerClient', () => {
  test('rejects non-stdio listen args at construction', () => {
    expect(
      () =>
        new OmoAppServerClient({
          args: ['app-server', '--listen', 'tcp://127.0.0.1:1234'],
        }),
    ).toThrow(/stdio/)
  })

  test('accepts default stdio args', () => {
    expect(() => makeClient()).not.toThrow()
  })

  test('start() sends initialize first and reaches ready state', async () => {
    const client = makeClient()
    expect(client.getState()).toBe('stopped')
    await withTimeout(client.start(), 'start()')
    expect(client.getState()).toBe('ready')
  })

  test('request() throws not-ready before start()', async () => {
    const client = makeClient()
    await expect(client.request('thread/listLoaded')).rejects.toThrow(
      'not-ready:stopped',
    )
  })

  test('request/response correlates by id and echoes params', async () => {
    const client = makeClient()
    await withTimeout(client.start(), 'start()')
    const result = await withTimeout(
      client.request<{ echoedMethod: string; receivedParams: unknown }>(
        'custom/method',
        { foo: 'bar' },
      ),
      'custom/method response',
    )
    expect(result.echoedMethod).toBe('custom/method')
    expect(result.receivedParams).toEqual({ foo: 'bar' })
  })

  test('concurrent requests resolve to their own results (id correlation)', async () => {
    const client = makeClient()
    await withTimeout(client.start(), 'start()')
    const [a, b] = await withTimeout(
      Promise.all([
        client.request<{ receivedParams: unknown }>('m/a', { tag: 'a' }),
        client.request<{ receivedParams: unknown }>('m/b', { tag: 'b' }),
      ]),
      'concurrent requests',
    )
    expect(a.receivedParams).toEqual({ tag: 'a' })
    expect(b.receivedParams).toEqual({ tag: 'b' })
  })

  test('error responses reject the request promise', async () => {
    const client = makeClient()
    await withTimeout(client.start(), 'start()')
    await expect(
      withTimeout(client.request('trigger/error'), 'trigger/error'),
    ).rejects.toThrow(/triggered error/)
  })

  test('notifications are delivered via onNotification', async () => {
    const notifications: JsonRpcNotification[] = []
    const client = makeClient({
      onNotification: (n) => notifications.push(n),
    })
    await withTimeout(client.start(), 'start()')
    await withTimeout(
      client.request('trigger/notification', { threadId: 'thread-xyz' }),
      'trigger/notification',
    )
    await waitFor(
      () => notifications.length > 0,
      'notification delivery',
    )
    expect(notifications[0]?.method).toBe('thread/statusChanged')
    expect(notifications[0]?.params).toMatchObject({ threadId: 'thread-xyz' })
    expect(typeof notifications[0]?.emittedAtMs).toBe('number')
  })

  test('server-requests are delivered and replyToServerRequest round-trips', async () => {
    const serverRequests: ApprovalServerRequest[] = []
    const notifications: JsonRpcNotification[] = []
    const client = makeClient({
      onServerRequest: (r) => serverRequests.push(r),
      onNotification: (n) => notifications.push(n),
    })
    await withTimeout(client.start(), 'start()')
    await withTimeout(
      client.request('trigger/serverRequest', { command: 'ls -la' }),
      'trigger/serverRequest',
    )
    await waitFor(() => serverRequests.length > 0, 'server-request delivery')

    const serverRequest = serverRequests[0]!
    expect(serverRequest.method).toBe(
      'item/commandExecution/requestApproval',
    )
    expect(serverRequest.params).toMatchObject({ command: 'ls -la' })

    client.replyToServerRequest(serverRequest.id, { decision: 'approved' })

    await waitFor(
      () =>
        notifications.some((n) => n.method === 'test/serverRequestReplyObserved'),
      'server-request reply round trip',
    )
    const echoed = notifications.find(
      (n) => n.method === 'test/serverRequestReplyObserved',
    )
    expect(echoed?.params).toMatchObject({
      id: serverRequest.id,
      result: { decision: 'approved' },
    })
  })

  test('shutdown() unsubscribes tracked threads and stops the child', async () => {
    const client = makeClient()
    await withTimeout(client.start(), 'start()')
    client.trackThread('thread-abc')

    await withTimeout(client.shutdown(), 'shutdown()')
    expect(client.getState()).toBe('stopped')

    await expect(client.request('thread/listLoaded')).rejects.toThrow(
      'not-ready:stopped',
    )
  })

  test('unexpected child exit while ready rejects pending requests', async () => {
    const client = makeClient({ autoRestart: false })
    await withTimeout(client.start(), 'start()')

    const pending = client.request('trigger/exit')
    await expect(withTimeout(pending, 'pending after exit')).rejects.toThrow(
      /exited unexpectedly/,
    )
    await waitFor(() => client.getState() === 'failed', 'state -> failed')
  })

  test('restart() respawns and re-initializes back to ready', async () => {
    const client = makeClient({ autoRestart: false })
    await withTimeout(client.start(), 'start()')

    await withTimeout(client.restart(), 'restart()')
    expect(client.getState()).toBe('ready')

    const result = await withTimeout(
      client.request<{ echoedMethod: string }>('post-restart/ping'),
      'post-restart request',
    )
    expect(result.echoedMethod).toBe('post-restart/ping')
  })
})
