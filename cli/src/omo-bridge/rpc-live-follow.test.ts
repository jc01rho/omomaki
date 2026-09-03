import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  omoFileEntriesToEvents,
  startLiveFollow,
  type LiveFollowHost,
} from './rpc-live-follow.js'

const POLL_MS = 30

function writeSessionFile(file: string, entries: Array<Record<string, unknown>>): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n')
  return fs.writeFile(file, lines + (lines ? '\n' : ''), 'utf8')
}

async function appendToSessionFile(file: string, entries: Array<Record<string, unknown>>): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n')
  await fs.appendFile(file, lines + '\n', 'utf8')
}

function userEntry(text: string, id: string): Record<string, unknown> {
  return {
    id,
    timestamp: new Date().toISOString(),
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    }
    await waitMs(20)
  }
}

describe('rpc-live-follow', () => {
  let tmpDir: string
  let sessionFile: string
  let host: LiveFollowHost
  let controllers: Array<{ stop(): void }>

  beforeEach(() => {
    tmpDir = ''
    sessionFile = ''
    controllers = []
  })

  afterEach(async () => {
    for (const c of controllers) c.stop()
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function startFollow(threadId: string, file: string, h: LiveFollowHost) {
    const ctrl = startLiveFollow({ threadId, sessionFile: file, host: h, pollMs: POLL_MS })
    controllers.push(ctrl)
    return ctrl
  }

  it('does not dispatch entries that already existed at start', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-live-follow-'))
    sessionFile = path.join(tmpDir, 'session.jsonl')
    host = { dispatch: vi.fn().mockResolvedValue(undefined), reload: vi.fn().mockResolvedValue(undefined) }
    await writeSessionFile(sessionFile, [userEntry('pre1', 'p1'), userEntry('pre2', 'p2')])
    startFollow('t1', sessionFile, host)
    await waitMs(POLL_MS * 3)
    expect(host.dispatch).not.toHaveBeenCalled()
  })

  it('dispatches events for externally appended entries (latest-first evidence)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-live-follow-'))
    sessionFile = path.join(tmpDir, 'session.jsonl')
    host = { dispatch: vi.fn().mockResolvedValue(undefined), reload: vi.fn().mockResolvedValue(undefined) }
    await writeSessionFile(sessionFile, [userEntry('baseline', 'b1')])
    startFollow('t1', sessionFile, host)
    await waitMs(POLL_MS * 3)
    expect(host.dispatch).not.toHaveBeenCalled()

    await appendToSessionFile(sessionFile, [userEntry('LIVE_APPEND', 'l1')])
    await waitUntil(() => (host.dispatch as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    const payloads = (host.dispatch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    const serialized = payloads.map((p) => JSON.stringify(p)).join('')
    expect(serialized).toContain('LIVE_APPEND')
    expect(serialized).toContain('message.part.updated')

    // no duplicate on further ticks without appends
    const callsNow = (host.dispatch as ReturnType<typeof vi.fn>).mock.calls.length
    await waitMs(POLL_MS * 3)
    expect((host.dispatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsNow)
  })

  it('stop() cancels the polling loop', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-live-follow-'))
    sessionFile = path.join(tmpDir, 'session.jsonl')
    host = { dispatch: vi.fn().mockResolvedValue(undefined), reload: vi.fn().mockResolvedValue(undefined) }
    await writeSessionFile(sessionFile, [userEntry('base', 'b')])
    const ctrl = startFollow('t1', sessionFile, host)
    await waitMs(POLL_MS * 2)
    ctrl.stop()
    await appendToSessionFile(sessionFile, [userEntry('after-stop', 'a')])
    await waitMs(POLL_MS * 3)
    expect(host.dispatch).not.toHaveBeenCalled()
  })

  it('supports multiple controllers for different threads', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-live-follow-'))
    sessionFile = path.join(tmpDir, 'session.jsonl')
    const host1 = { dispatch: vi.fn().mockResolvedValue(undefined), reload: vi.fn().mockResolvedValue(undefined) }
    const host2 = { dispatch: vi.fn().mockResolvedValue(undefined), reload: vi.fn().mockResolvedValue(undefined) }
    await writeSessionFile(sessionFile, [userEntry('base', 'b')])
    startFollow('t1', sessionFile, host1)
    startFollow('t2', sessionFile, host2)
    await waitMs(POLL_MS * 2)
    await appendToSessionFile(sessionFile, [userEntry('multi', 'm1')])
    await waitUntil(() =>
      (host1.dispatch as ReturnType<typeof vi.fn>).mock.calls.length > 0 &&
      (host2.dispatch as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    )
  })
})

describe('omoFileEntriesToEvents', () => {
  it('converts a user text message entry to message.updated + text part events', () => {
    const dir = '/home/whrho/git/AUTOTEST-GROUP'
    const id = '01a0test'
    const events = omoFileEntriesToEvents(
      [
        {
          id,
          timestamp: '2026-09-02T00:00:00.000Z',
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        },
      ],
      { directory: dir },
    )
    const serialized = JSON.stringify(events)
    expect(serialized).toContain('message.updated')
    expect(serialized).toContain('message.part.updated')
    expect(serialized).toContain('hello')
    expect(serialized).toContain('01a0test')
  })

  it('ignores non-message entries and empty text', () => {
    const events = omoFileEntriesToEvents(
      [
        { id: 'h1', type: 'session_info', cwd: '/x' },
        { id: 'h2', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'real' }] } },
        { id: 'h3', type: 'model_change', provider: 'p', modelId: 'm' },
      ],
      { directory: '/x' },
    )
    // Only the message entry should produce events
    expect(events.length).toBe(2)
    expect(JSON.stringify(events)).toContain('real')
  })
})
