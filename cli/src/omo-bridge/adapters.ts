// Param builders for thread/turn app-server calls.
//
// Centralizes two omomaki wire policies so call sites cannot drift:
// - Every thread/start|resume|fork request must send
//   approvalPolicy:"on-request", approvalsReviewer:"user" (verified live;
//   sandbox stays dangerFullAccess regardless).
// - Every turn/start request must send exactly one {type:"text",text}
//   input item, since the installed runtime's parseInput rejects any other
//   item type with -32602 despite the wire type declaring more variants.

import { translateDiscordTurnInput } from './input-translation.js'
import type {
  ThreadForkParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
} from './types.js'

const APPROVAL_POLICY = 'on-request'
const APPROVALS_REVIEWER = 'user'

function assertAbsoluteCwd(cwd: string): void {
  if (!cwd.startsWith('/')) {
    throw new TypeError(`cwd must be absolute: ${cwd}`)
  }
}

export function buildThreadStartParams(opts: {
  cwd: string
  model?: string
}): ThreadStartParams {
  assertAbsoluteCwd(opts.cwd)
  return {
    cwd: opts.cwd,
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: APPROVALS_REVIEWER,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  }
}

export function buildThreadResumeParams(opts: {
  threadId: string
  cwd?: string
}): ThreadResumeParams {
  if (opts.cwd !== undefined) {
    assertAbsoluteCwd(opts.cwd)
  }
  return {
    threadId: opts.threadId,
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: APPROVALS_REVIEWER,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  }
}

export function buildThreadForkParams(opts: {
  threadId: string
  cwd?: string
}): ThreadForkParams {
  if (opts.cwd !== undefined) {
    assertAbsoluteCwd(opts.cwd)
  }
  return {
    threadId: opts.threadId,
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: APPROVALS_REVIEWER,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  }
}

export function buildTurnStartParams(opts: {
  threadId: string
  text: string
  clientUserMessageId: string
  imagePaths?: readonly string[]
  skill?: { name: string; path: string }
  mentions?: readonly { name: string; path: string }[]
}): TurnStartParams {
  if (opts.clientUserMessageId.length === 0) {
    throw new TypeError('clientUserMessageId must not be empty')
  }

  const input = translateDiscordTurnInput({
    text: opts.text,
    imagePaths: opts.imagePaths,
    skill: opts.skill,
    mentions: opts.mentions,
  })

  return {
    threadId: opts.threadId,
    input,
    clientUserMessageId: opts.clientUserMessageId,
  }
}

export function buildTurnInterruptParams(
  threadId: string,
  turnId: string,
): TurnInterruptParams {
  return { threadId, turnId }
}
