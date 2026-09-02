// Discord-agnostic approval bridge for omo app-server server-requests.
//
// The app-server pushes server-requests (approval prompts) that must be
// answered. This module owns the accept/decline decision lifecycle only —
// it knows nothing about Discord, Slack, or any other transport. Callers
// supply a `presenter` (asks a human, returns a decision) and a `reply`
// (sends the decision back over the wire, shape TBD by the caller).
//
// Fail-closed: any failure mode (no presenter, presenter throws, timeout,
// duplicate id, or shutdown while pending) resolves to 'decline', and
// `reply` is invoked exactly once per request id.

import type { JsonRpcRequestId } from './types.js'

export type ApprovalDecision = 'accept' | 'decline'

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])

export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method)
}

export type ApprovalServerRequestLike = {
  id: JsonRpcRequestId
  method: string
  params?: unknown
}

export type ApprovalPresenter = (
  request: ApprovalServerRequestLike,
) => Promise<ApprovalDecision>

export type ApprovalReply = (
  id: JsonRpcRequestId,
  decision: ApprovalDecision,
) => void

export type ApprovalBridgeOptions = {
  defaultTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

type PendingApproval = {
  timer: ReturnType<typeof setTimeout>
  settled: boolean
  reply: ApprovalReply
}

export class ApprovalBridge {
  private readonly defaultTimeoutMs: number
  private readonly pending = new Map<JsonRpcRequestId, PendingApproval>()
  private closed = false

  constructor(options: ApprovalBridgeOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  pendingCount(): number {
    return this.pending.size
  }

  handle(
    request: ApprovalServerRequestLike,
    presenter: ApprovalPresenter | undefined,
    reply: ApprovalReply,
  ): void {
    const { id } = request

    if (this.closed) {
      reply(id, 'decline')
      return
    }

    if (this.pending.has(id)) {
      reply(id, 'decline')
      return
    }

    const settle = (decision: ApprovalDecision): void => {
      const entry = this.pending.get(id)
      if (!entry || entry.settled) return
      entry.settled = true
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reply(id, decision)
    }

    const timer = setTimeout(() => {
      settle('decline')
    }, this.defaultTimeoutMs)

    this.pending.set(id, { timer, settled: false, reply })

    if (!presenter) {
      settle('decline')
      return
    }

    presenter(request).then(
      (decision) => settle(decision),
      () => settle('decline'),
    )
  }

  shutdown(): void {
    this.closed = true
    for (const [id, entry] of this.pending) {
      if (entry.settled) continue
      entry.settled = true
      clearTimeout(entry.timer)
      entry.reply(id, 'decline')
    }
    this.pending.clear()
  }
}
