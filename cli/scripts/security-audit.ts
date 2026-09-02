#!/usr/bin/env tsx
// Security audit for classic omo RPC (`OmoRpcClient`).
//
// Runs one or more named checks and prints PASS/FAIL per check. Exits 0
// only when every requested check passes; exits 1 if any check fails;
// exits 2 for usage errors (unknown check name, bad --check value).
//
// Checks:
// - stdio-only: OmoRpcClient rejects --listen (including stdio://) at
//   construction time, and accepts classic --mode rpc args.
// - project-root: canonicalizeProjectPath accepts in-root paths and
//   rejects '..' / outside-root / symlink-escape paths, in a real temp dir.
// - approval-roundtrip: fake classic RPC child emits extension_ui_request
//   confirm; client replies confirmed:false. Fail-closed: no confirm
//   means FAIL. Does not write ~/.omo/agent/extensions.
//
// Usage: tsx scripts/security-audit.ts --check stdio-only,approval-roundtrip,project-root

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApprovalBridge } from '../src/omo-bridge/approvals.js'
import { canonicalizeProjectPath } from '../src/omo-bridge/project-paths.js'
import { OmoRpcClient } from '../src/omo-bridge/rpc-client.js'

const KNOWN_CHECKS = ['stdio-only', 'approval-roundtrip', 'project-root'] as const
type CheckName = (typeof KNOWN_CHECKS)[number]

const APPROVAL_ROUNDTRIP_TIMEOUT_MS = 8_000
const FIXTURE_PATH = fileURLToPath(
  new URL('../src/omo-bridge/__fixtures__/fake-rpc-server.mjs', import.meta.url),
)

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
    new OmoRpcClient({
      args: ['--mode', 'rpc', '--listen', 'ws://127.0.0.1:18990'],
    })
    return {
      name: 'stdio-only',
      pass: false,
      detail: 'construction did not throw for --listen ws://',
    }
  } catch (error) {
    if (!String(error).includes('--listen')) {
      return {
        name: 'stdio-only',
        pass: false,
        detail: `construction threw, but not for --listen: ${String(error)}`,
      }
    }
  }

  try {
    new OmoRpcClient({
      args: ['--mode', 'rpc', '--listen', 'stdio://'],
    })
    return {
      name: 'stdio-only',
      pass: false,
      detail: 'construction did not throw for --listen stdio://',
    }
  } catch (error) {
    if (!String(error).includes('--listen')) {
      return {
        name: 'stdio-only',
        pass: false,
        detail: `stdio:// throw was not about --listen: ${String(error)}`,
      }
    }
  }

  try {
    new OmoRpcClient({ args: ['--mode', 'rpc'] })
  } catch (error) {
    return {
      name: 'stdio-only',
      pass: false,
      detail: `classic --mode rpc unexpectedly threw at construction: ${String(error)}`,
    }
  }

  return {
    name: 'stdio-only',
    pass: true,
    detail:
      'construction throws for --listen including stdio://; classic --mode rpc accepted',
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
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
      canonicalizeProjectPath(root + '/a/b/../b', [root])
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
        "inside-root accepted; '..', outside-root, symlink-escape, and empty-roots all rejected",
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function checkApprovalRoundtrip(): Promise<CheckResult> {
  const confirmIds: string[] = []
  const declinedIds: string[] = []
  const bridge = new ApprovalBridge()

  const client = new OmoRpcClient({
    command: process.execPath,
    args: [FIXTURE_PATH],
    stderr: () => {},
    onExtensionUiRequest: (request) => {
      confirmIds.push(request.id)
      bridge.handle(
        { id: request.id, method: 'item/commandExecution/requestApproval' },
        async () => 'decline',
        (id, decision) => {
          if (decision === 'decline') {
            declinedIds.push(String(id))
          }
          void client.respondToExtensionUi(String(id), {
            confirmed: decision === 'accept',
          })
        },
      )
    },
  })

  try {
    await client.start()
    const prompt = client.prompt('touch-denied should-not-exist')
    const settled = client.waitForSettled()
    await Promise.race([
      Promise.all([prompt, settled]),
      new Promise<void>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('timed out waiting for deny roundtrip')),
          APPROVAL_ROUNDTRIP_TIMEOUT_MS,
        )
      }),
    ])
  } catch (error) {
    await client.stop().catch(() => {})
    bridge.shutdown()
    return {
      name: 'approval-roundtrip',
      pass: false,
      detail: `SECURITY-GATE-FAIL: ${String(error)} confirms=${JSON.stringify(confirmIds)}`,
    }
  }

  await client.stop().catch(() => {})
  bridge.shutdown()

  if (confirmIds.length === 0) {
    return {
      name: 'approval-roundtrip',
      pass: false,
      detail: 'SECURITY-GATE-FAIL: no approval roundtrip',
    }
  }
  if (declinedIds.length === 0) {
    return {
      name: 'approval-roundtrip',
      pass: false,
      detail:
        'SECURITY-GATE-FAIL: approval request(s) arrived but none were declined. ' +
        JSON.stringify(confirmIds),
    }
  }
  return {
    name: 'approval-roundtrip',
    pass: true,
    detail: `observed ${confirmIds.length} confirm request(s), declined ${declinedIds.length}`,
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

void main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`security-audit: unexpected error: ${String(error)}\n`)
    process.exit(1)
  })
