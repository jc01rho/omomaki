#!/usr/bin/env tsx
// Security audit for the omo app-server integration.
//
// Runs one or more named checks and prints PASS/FAIL per check. Exits 0
// only when every requested check passes; exits 1 if any check fails;
// exits 2 for usage errors (unknown check name, bad --check value).
//
// Checks:
// - stdio-only: OmoAppServerClient rejects a non-stdio --listen target at
//   construction time, and accepts the default stdio args.
// - project-root: canonicalizeProjectPath accepts in-root paths and
//   rejects '..' / outside-root / symlink-escape paths, in a real temp dir.
// - approval-roundtrip: REAL round trip against a live `omo app-server`.
//   Starts a thread with approvalPolicy:"on-request" in a temp project
//   dir, starts a turn instructing the agent to run a harmless shell
//   command, and asserts at least one approval server-request arrived and
//   was declined via ApprovalBridge before the turn completed. This is a
//   security gate, not a soft check — it prints
//   'SECURITY-GATE-FAIL: no approval roundtrip' and exits 1 if the turn
//   completes without any approval request ever reaching the client.
//   Never weaken this check to make it pass.
//
// Usage: tsx scripts/security-audit.ts --check stdio-only,approval-roundtrip,project-root

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApprovalBridge, isApprovalMethod } from '../src/omo-bridge/approvals.js'
import { buildThreadStartParams, buildTurnStartParams } from '../src/omo-bridge/adapters.js'
import { OmoAppServerClient } from '../src/omo-bridge/client.js'
import { canonicalizeProjectPath } from '../src/omo-bridge/project-paths.js'
import type { ApprovalServerRequest } from '../src/omo-bridge/types.js'

const KNOWN_CHECKS = ['stdio-only', 'approval-roundtrip', 'project-root'] as const
type CheckName = (typeof KNOWN_CHECKS)[number]

const APPROVAL_ROUNDTRIP_TIMEOUT_MS = 180_000

type CheckResult = { name: CheckName; pass: boolean; detail: string }

function parseArgs(argv: readonly string[]): CheckName[] {
  let raw: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') {
      raw = argv[i + 1]
      i++
    }
  }
  if (!raw) {
    throw new UsageError('--check <comma-separated-list> is required')
  }
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (names.length === 0) {
    throw new UsageError('--check must list at least one check name')
  }
  for (const name of names) {
    if (!(KNOWN_CHECKS as readonly string[]).includes(name)) {
      throw new UsageError(
        `unknown check: ${name} (known: ${KNOWN_CHECKS.join(', ')})`,
      )
    }
  }
  return names as CheckName[]
}

class UsageError extends Error {}

function checkStdioOnly(): CheckResult {
  try {
    new OmoAppServerClient({
      args: ['app-server', '--listen', 'ws://127.0.0.1:18990'],
    })
    return {
      name: 'stdio-only',
      pass: false,
      detail: 'construction did not throw for a non-stdio --listen target',
    }
  } catch (error) {
    if (!String(error).includes('stdio')) {
      return {
        name: 'stdio-only',
        pass: false,
        detail: `construction threw, but not for the stdio reason: ${String(error)}`,
      }
    }
  }

  try {
    new OmoAppServerClient({})
  } catch (error) {
    return {
      name: 'stdio-only',
      pass: false,
      detail: `default stdio args unexpectedly threw at construction: ${String(error)}`,
    }
  }

  return {
    name: 'stdio-only',
    pass: true,
    detail:
      'construction throws for non-stdio --listen targets; default stdio args accepted',
  }
}

function checkProjectRoot(): CheckResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-audit-project-root-'))
  try {
    const root = path.join(tmpDir, 'root')
    const outside = path.join(tmpDir, 'outside')
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(root, 'nested', 'file.txt'), 'ok')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')

    const failures: string[] = []

    try {
      canonicalizeProjectPath(path.join(root, 'nested', 'file.txt'), [root])
    } catch (error) {
      failures.push(`inside-root path was rejected: ${String(error)}`)
    }

    try {
      canonicalizeProjectPath(path.join(root, 'a', '..', 'nested'), [root])
      failures.push("raw '..' path was NOT rejected")
    } catch {
      // expected
    }

    try {
      canonicalizeProjectPath(outside, [root])
      failures.push('outside-root path was NOT rejected')
    } catch {
      // expected
    }

    const escapeLink = path.join(root, 'escape')
    fs.symlinkSync(outside, escapeLink)
    try {
      canonicalizeProjectPath(path.join(escapeLink, 'secret.txt'), [root])
      failures.push('symlink-escape path was NOT rejected')
    } catch {
      // expected
    }

    try {
      canonicalizeProjectPath(root, [])
      failures.push('empty project roots did NOT reject everything')
    } catch {
      // expected
    }

    if (failures.length > 0) {
      return { name: 'project-root', pass: false, detail: failures.join('; ') }
    }
    return {
      name: 'project-root',
      pass: true,
      detail:
        'inside-root accepted; \'..\', outside-root, symlink-escape, and empty-roots all rejected',
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function checkApprovalRoundtrip(): Promise<CheckResult> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'omo-audit-approval-roundtrip-'),
  )
  const transcript: ApprovalServerRequest[] = []
  const declinedApprovalIds: unknown[] = []
  const bridge = new ApprovalBridge()

  let threadId: string | undefined
  let resolveTurnCompleted: (() => void) | undefined
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurnCompleted = resolve
  })

  const client: OmoAppServerClient = new OmoAppServerClient({
    cwd: tmpDir,
    stderr: () => {},
    onServerRequest: (request) => {
      transcript.push(request)
      bridge.handle(
        request,
        async () => 'decline',
        (id, decision) => {
          if (decision === 'decline') declinedApprovalIds.push(id)
          client.replyToServerRequest(id, { decision })
        },
      )
    },
    onNotification: (notification) => {
      if (
        notification.method === 'turn/completed' &&
        threadId !== undefined &&
        typeof notification.params === 'object' &&
        notification.params !== null &&
        (notification.params as { threadId?: unknown }).threadId === threadId
      ) {
        resolveTurnCompleted?.()
      }
    },
  })

  try {
    await client.start()
    const threadResponse = (await client.startThread(
      buildThreadStartParams({ cwd: tmpDir }),
    )) as unknown as { thread: { id: string } }
    threadId = threadResponse.thread.id

    await client.startTurn(
      buildTurnStartParams({
        threadId,
        text:
          'Run this exact shell command now, with no explanation: ' +
          'touch omomaki-approval-probe.tmp',
        clientUserMessageId: 'security-audit-approval-roundtrip',
      }),
    )

    await Promise.race([
      turnCompleted,
      new Promise<void>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('timed out waiting for turn/completed')),
          APPROVAL_ROUNDTRIP_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    await client.shutdown().catch(() => {})
    bridge.shutdown()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  const approvalRequests = transcript.filter((r) => isApprovalMethod(r.method))
  if (approvalRequests.length === 0) {
    return {
      name: 'approval-roundtrip',
      pass: false,
      detail:
        'SECURITY-GATE-FAIL: no approval roundtrip. Full server-request transcript: ' +
        JSON.stringify(transcript),
    }
  }
  if (declinedApprovalIds.length === 0) {
    return {
      name: 'approval-roundtrip',
      pass: false,
      detail:
        'SECURITY-GATE-FAIL: approval request(s) arrived but none were declined. Transcript: ' +
        JSON.stringify(transcript),
    }
  }
  return {
    name: 'approval-roundtrip',
    pass: true,
    detail: `observed ${approvalRequests.length} approval request(s), declined ${declinedApprovalIds.length}`,
  }
}

async function main(): Promise<number> {
  let checks: CheckName[]
  try {
    checks = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`security-audit: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const results: CheckResult[] = []
  for (const check of checks) {
    if (check === 'stdio-only') {
      results.push(checkStdioOnly())
    } else if (check === 'project-root') {
      results.push(checkProjectRoot())
    } else if (check === 'approval-roundtrip') {
      results.push(await checkApprovalRoundtrip())
    }
  }

  let allPass = true
  for (const result of results) {
    const status = result.pass ? 'PASS' : 'FAIL'
    if (!result.pass) allPass = false
    process.stdout.write(`[${status}] ${result.name}: ${result.detail}\n`)
  }

  return allPass ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`security-audit: unexpected error: ${String(error)}\n`)
    process.exit(1)
  })
