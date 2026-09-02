// Unit tests for ApprovalBridge fail-closed semantics. All async waits are
// bounded via vi.waitFor / explicit timeouts — no fixed sleeps.

import { describe, expect, test, vi } from 'vitest'
import { ApprovalBridge, isApprovalMethod } from './approvals.js'
import type {
  ApprovalDecision,
  ApprovalServerRequestLike,
} from './approvals.js'

function makeRequest(
  overrides: Partial<ApprovalServerRequestLike> = {},
): ApprovalServerRequestLike {
  return {
    id: 1,
    method: 'item/commandExecution/requestApproval',
    params: { command: 'ls' },
    ...overrides,
  }
}

describe('isApprovalMethod', () => {
  test('true for the three known approval methods', () => {
    expect(isApprovalMethod('item/commandExecution/requestApproval')).toBe(
      true,
    )
    expect(isApprovalMethod('item/fileChange/requestApproval')).toBe(true)
    expect(isApprovalMethod('item/permissions/requestApproval')).toBe(true)
  })

  test('false for unrelated methods', () => {
    expect(isApprovalMethod('thread/statusChanged')).toBe(false)
    expect(isApprovalMethod('')).toBe(false)
  })
})

describe('ApprovalBridge', () => {
  test('accept path: presenter resolves accept -> reply(id, accept) once', async () => {
    const bridge = new ApprovalBridge()
    const reply = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const presenter = vi.fn(async () => 'accept' as const)

    bridge.handle(makeRequest(), presenter, reply)

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply).toHaveBeenCalledWith(1, 'accept')
    expect(bridge.pendingCount()).toBe(0)
  })

  test('decline path: presenter resolves decline -> reply(id, decline) once', async () => {
    const bridge = new ApprovalBridge()
    const reply = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const presenter = vi.fn(async () => 'decline' as const)

    bridge.handle(makeRequest(), presenter, reply)

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply).toHaveBeenCalledWith(1, 'decline')
    expect(bridge.pendingCount()).toBe(0)
  })

  test('presenter throws -> decline, reply called exactly once', async () => {
    const bridge = new ApprovalBridge()
    const reply = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const presenter = vi.fn(async () => {
      throw new Error('boom')
    })

    bridge.handle(makeRequest(), presenter, reply)

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply).toHaveBeenCalledWith(1, 'decline')
    expect(bridge.pendingCount()).toBe(0)
  })

  test('missing presenter -> decline, reply called exactly once', async () => {
    const bridge = new ApprovalBridge()
    const reply = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()

    bridge.handle(makeRequest(), undefined, reply)

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply).toHaveBeenCalledWith(1, 'decline')
    expect(bridge.pendingCount()).toBe(0)
  })

  test('timeout: never-settling presenter -> decline after defaultTimeoutMs, reply called exactly once', async () => {
    const bridge = new ApprovalBridge({ defaultTimeoutMs: 10 })
    const reply = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const presenter = vi.fn(() => new Promise<ApprovalDecision>(() => {}))

    bridge.handle(makeRequest(), presenter, reply)

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    })
    expect(reply).toHaveBeenCalledWith(1, 'decline')
    expect(bridge.pendingCount()).toBe(0)
  })

  test('shutdown() with pending requests declines them immediately, reply called exactly once each', () => {
    const bridge = new ApprovalBridge()
    const replyA = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const replyB = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const neverSettles = () => new Promise<ApprovalDecision>(() => {})

    bridge.handle(makeRequest({ id: 1 }), neverSettles, replyA)
    bridge.handle(makeRequest({ id: 2 }), neverSettles, replyB)
    expect(bridge.pendingCount()).toBe(2)

    bridge.shutdown()

    expect(replyA).toHaveBeenCalledTimes(1)
    expect(replyA).toHaveBeenCalledWith(1, 'decline')
    expect(replyB).toHaveBeenCalledTimes(1)
    expect(replyB).toHaveBeenCalledWith(2, 'decline')
    expect(bridge.pendingCount()).toBe(0)
  })

  test('handle() after shutdown() declines immediately without invoking presenter', () => {
    const bridge = new ApprovalBridge()
    bridge.shutdown()

    const reply = vi.fn<(id: unknown, decision: ApprovalDecision) => void>()
    const presenter = vi.fn(async () => 'accept' as const)

    bridge.handle(makeRequest(), presenter, reply)

    expect(presenter).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith(1, 'decline')
  })

  test('duplicate id while first is pending -> second handle() declines immediately, first still resolves once', async () => {
    const bridge = new ApprovalBridge()
    const replyFirst = vi.fn<
      (id: unknown, decision: ApprovalDecision) => void
    >()
    const replySecond = vi.fn<
      (id: unknown, decision: ApprovalDecision) => void
    >()

    let resolveFirst: ((decision: ApprovalDecision) => void) | undefined
    const firstPresenter = vi.fn(
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          resolveFirst = resolve
        }),
    )
    const secondPresenter = vi.fn(async () => 'accept' as const)

    bridge.handle(makeRequest({ id: 5 }), firstPresenter, replyFirst)
    bridge.handle(makeRequest({ id: 5 }), secondPresenter, replySecond)

    // Duplicate id declines synchronously without consulting its presenter.
    expect(secondPresenter).not.toHaveBeenCalled()
    expect(replySecond).toHaveBeenCalledTimes(1)
    expect(replySecond).toHaveBeenCalledWith(5, 'decline')

    await vi.waitFor(() => expect(resolveFirst).toBeDefined())
    resolveFirst?.('accept')
    await vi.waitFor(() => expect(replyFirst).toHaveBeenCalledTimes(1))
    expect(replyFirst).toHaveBeenCalledWith(5, 'accept')
  })
})
