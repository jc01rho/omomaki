#!/usr/bin/env tsx
// Smoke test against a REAL `omo app-server` process.
//
// Spawns OmoAppServerClient (stdio transport only), sends `initialize`,
// starts a thread via buildThreadStartParams({ cwd }), and prints the
// resulting { threadId, approvalPolicy, sandbox } as JSON. Exits 0 only
// when the server actually honored approvalPolicy:"on-request" — this is
// the omomaki policy invariant (every thread/start must get on-request),
// not a soft preference.
//
// Usage: tsx scripts/smoke-omo-app-server.ts [--cwd <path>]
// Defaults --cwd to cli/fixtures/demo-project (relative to this script).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildThreadStartParams } from '../src/omo-bridge/adapters.js'
import { OmoAppServerClient } from '../src/omo-bridge/client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CWD = path.join(__dirname, '..', 'fixtures', 'demo-project')

type ThreadStartResult = {
  thread: { id: string }
  approvalPolicy?: string
  sandbox?: { type: string }
}

function parseArgs(argv: readonly string[]): { cwd: string } {
  let cwd = DEFAULT_CWD
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--cwd requires a value')
      }
      cwd = value
      i++
    }
  }
  return { cwd: path.resolve(cwd) }
}

async function main(): Promise<number> {
  const { cwd } = parseArgs(process.argv.slice(2))

  let client: OmoAppServerClient
  try {
    client = new OmoAppServerClient({
      stderr: (line) => process.stderr.write(`[omo] ${line}\n`),
    })
  } catch (error) {
    process.stderr.write(
      `smoke-omo-app-server: failed to construct client: ${String(error)}\n`,
    )
    return 2
  }

  try {
    await client.start()
  } catch (error) {
    const message = String(error)
    if (
      message.includes('ENOENT') ||
      message.includes('command not found') ||
      message.includes('spawn omo')
    ) {
      process.stderr.write(
        `smoke-omo-app-server: 'omo' binary missing or unspawnable: ${message}\n`,
      )
      return 2
    }
    process.stderr.write(`smoke-omo-app-server: start() failed: ${message}\n`)
    return 1
  }

  try {
    const response = (await client.startThread(
      buildThreadStartParams({ cwd }),
    )) as unknown as ThreadStartResult

    const summary = {
      threadId: response.thread?.id,
      approvalPolicy: response.approvalPolicy,
      sandbox: response.sandbox,
    }
    process.stdout.write(JSON.stringify(summary) + '\n')

    if (response.approvalPolicy === 'on-request') {
      return 0
    }

    process.stderr.write(
      `smoke-omo-app-server: approvalPolicy not honored, got response: ${JSON.stringify(response)}\n`,
    )
    return 1
  } catch (error) {
    process.stderr.write(
      `smoke-omo-app-server: thread/start failed: ${String(error)}\n`,
    )
    return 1
  } finally {
    await client.shutdown().catch(() => {})
  }
}

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    process.stderr.write(`smoke-omo-app-server: unexpected error: ${String(error)}\n`)
    process.exit(1)
  })
