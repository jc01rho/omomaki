import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { attachJsonlLineReader, serializeJsonLine } from './rpc-jsonl.js'

const DEFAULT_COMMAND = 'omo'
const DEFAULT_ARGS = ['--mode', 'rpc'] as const
const FORCE_KILL_TIMEOUT_MS = 2_000

type RpcId = string | number

type RpcFrame = {
  [key: string]: unknown
  type: string
}

type OmoEvent = {
  type: string
  delta?: string
  [key: string]: unknown
}

type OmoExtensionUiRequest = {
  id: string
  method: string
  title?: string
  message?: string
  timeout?: number
}

export type OmoRpcClientOptions = {
  command?: string
  args?: string[]
  cwd?: string
  stderr?: (line: string) => void
  onEvent?: (event: { type: string; delta?: string }) => void
  onExtensionUiRequest?: (request: {
    id: string
    method: string
    title?: string
    message?: string
    timeout?: number
  }) => void
}

type PendingRequest = {
  resolve: () => void
  reject: (error: Error) => void
}

type SettledWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRpcFrame(value: unknown): value is RpcFrame {
  return isRecord(value) && typeof value.type === 'string'
}

function extractRpcId(value: RpcFrame): RpcId | null {
  const candidate = value.id
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return candidate
  }
  return null
}

function collectListenTargets(args: string[]): string[] {
  const targets: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === undefined) {
      continue
    }
    if (arg === '--listen') {
      const next = args[i + 1]
      if (next !== undefined) {
        targets.push(next)
      } else {
        targets.push('')
      }
      continue
    }
    if (arg.startsWith('--listen=')) {
      targets.push(arg.slice('--listen='.length))
    }
  }

  return targets
}

function buildErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'RPC request failed'
}

export class OmoRpcClient {
  private readonly command: string
  private readonly args: string[]
  private readonly cwd: string | undefined
  private readonly onStderr: (line: string) => void
  private readonly onEventCallback: (event: OmoEvent) => void
  private readonly onExtensionUiRequestCallback: (request: OmoExtensionUiRequest) => void

  private child: ChildProcessWithoutNullStreams | null = null
  private state: 'stopped' | 'starting' | 'running' = 'stopped'
  private nextId = 1

  private readonly pendingRequests = new Map<RpcId, PendingRequest>()
  private readonly settledWaiters = new Set<SettledWaiter>()

  private detachStdout: (() => void) | null = null
  private detachStderr: (() => void) | null = null
  private isStopping = false

  private settledCount = 0

  constructor(options: OmoRpcClientOptions = {}) {
    const args = [...(options.args ?? DEFAULT_ARGS)]

    const listenTargets = collectListenTargets(args)
    if (listenTargets.length > 0) {
      throw new Error(
        'OmoRpcClient requires process stdio only; --listen enables multi-session on omo 2026.9.x',
      )
    }

    const hasMultiSession = args.some((arg) => arg.startsWith('--multi-session'))
    if (hasMultiSession) {
      throw new Error(
        'classic/legacy mode is unsupported: --multi-session requests a legacy sessioning mode',
      )
    }

    this.command = options.command ?? DEFAULT_COMMAND
    this.args = args
    this.cwd = options.cwd
    this.onStderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`))
    this.onEventCallback = options.onEvent ?? (() => {})
    this.onExtensionUiRequestCallback =
      options.onExtensionUiRequest ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' || this.child !== null) {
      throw new Error(`cannot start from state: ${this.state}`)
    }

    this.state = 'starting'
    this.isStopping = false

    try {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        stdio: 'pipe',
      })
      this.child = child

      this.detachStdout = attachJsonlLineReader(child.stdout, (line) => {
        this.handleStdoutLine(line)
      })

      this.detachStderr = this.attachStderrReader(child.stderr)

      child.once('exit', (code, signal) => {
        this.handleChildExit(code, signal)
      })

      this.state = 'running'
    } catch (error) {
      this.state = 'stopped'
      this.child = null
      throw error instanceof Error ? error : new Error(String(error))
    }

    if (!this.child || this.child.exitCode !== null) {
      throw new Error('omo rpc child failed to start')
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return
    }

    this.isStopping = true

    const child = this.child
    if (!child) {
      this.state = 'stopped'
      this.isStopping = false
      return
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      this.cleanupAfterExit()
      this.state = 'stopped'
      this.isStopping = false
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false

      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const onExit = () => {
        clearTimeout(forceKillTimer)
        done()
      }

      const forceKillTimer = setTimeout(() => {
        if (settled) return
        child.kill('SIGKILL')
      }, FORCE_KILL_TIMEOUT_MS)

      child.once('exit', onExit)
      child.kill('SIGTERM')
    })

    this.cleanupAfterExit()
    this.state = 'stopped'
    this.isStopping = false
  }

  async prompt(message: string): Promise<void> {
    if (this.state !== 'running' || !this.child) {
      throw new Error('client is not running')
    }

    const id = this.nextId
    this.nextId += 1

    const completion = new Promise<void>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
    })

    this.write({ id, type: 'prompt', message })
    return completion
  }

  async waitForSettled(): Promise<void> {
    if (this.state === 'stopped') {
      throw new Error('client is stopped')
    }
    if (this.settledCount > 0) {
      this.settledCount -= 1
      return
    }
    return new Promise<void>((resolve, reject) => {
      this.settledWaiters.add({
        resolve: () => {
          resolve()
        },
        reject,
      })
    })
  }

  async respondToExtensionUi(
    id: string,
    body: { confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> {
    this.write({
      id,
      type: 'extension_ui_response',
      ...body,
    })
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('client stdin is not writable')
    }
    this.child.stdin.write(serializeJsonLine(payload))
  }

  private handleStdoutLine(line: string): void {
    if (line.trim().length === 0) return

    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch (error) {
      this.onStderr(`failed to parse stdout JSON: ${String(error)}`)
      return
    }

    if (!isRpcFrame(frame)) {
      this.onStderr(`ignoring malformed stdout frame: ${line}`)
      return
    }

    const id = extractRpcId(frame)
    if (id !== null && frame.type === 'response') {
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        const success = frame.success
        if (success === false) {
          const reason = buildErrorMessage(frame.error)
          pending.reject(new Error(`request ${id} failed: ${reason}`))
          return
        }
        pending.resolve()
        return
      }
    }

    if (frame.type === 'agent_settled') {
      if (this.settledWaiters.size === 0) {
        this.settledCount += 1
      } else {
        for (const waiter of this.settledWaiters) {
          waiter.resolve()
        }
        this.settledWaiters.clear()
      }
    }

    const nested =
      frame.type === 'message_update' && isRecord(frame.assistantMessageEvent)
        ? frame.assistantMessageEvent
        : null
    const nestedType =
      nested && typeof nested.type === 'string' ? nested.type : null
    const nestedDelta =
      nested && typeof nested.delta === 'string' ? nested.delta : undefined
    const topDelta = typeof frame.delta === 'string' ? frame.delta : undefined

    const event: OmoEvent = {
      ...frame,
      type: frame.type,
      delta: topDelta ?? nestedDelta,
    }
    this.onEventCallback(event)
    if (nestedType === 'text_delta' && nestedDelta !== undefined) {
      this.onEventCallback({ type: 'text_delta', delta: nestedDelta })
    }

    if (frame.type === 'extension_ui_request') {
      const request: OmoExtensionUiRequest = {
        id: typeof frame.id === 'string' ? frame.id : String(id ?? ''),
        method: typeof frame.method === 'string' ? frame.method : '',
        title: typeof frame.title === 'string' ? frame.title : undefined,
        message:
          typeof frame.message === 'string' ? frame.message : undefined,
        timeout:
          typeof frame.timeout === 'number' ? frame.timeout : undefined,
      }
      this.onExtensionUiRequestCallback(request)
    }
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(
      `omo rpc client exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
    )

    for (const [, pending] of this.pendingRequests) {
      pending.reject(error)
    }
    this.pendingRequests.clear()

    for (const waiter of this.settledWaiters) {
      waiter.reject(error)
    }
    this.settledWaiters.clear()

    this.cleanupAfterExit()
    this.state = 'stopped'
  }

  private cleanupAfterExit(): void {
    if (this.detachStdout) {
      this.detachStdout()
      this.detachStdout = null
    }
    if (this.detachStderr) {
      this.detachStderr()
      this.detachStderr = null
    }
    this.child = null
  }

  private attachStderrReader(
    stream: NodeJS.ReadableStream,
  ): () => void {
    const decoder = new StringDecoder('utf8')
    let buffer = ''

    const onData = (chunk: Buffer | string) => {
      buffer +=
        typeof chunk === 'string'
          ? chunk
          : decoder.write(chunk)

      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const rawLine = buffer.substring(0, index)
        buffer = buffer.substring(index + 1)
        const line = rawLine.endsWith('\r')
          ? rawLine.substring(0, rawLine.length - 1)
          : rawLine
        if (line.length > 0) {
          this.onStderr(line)
        }
        index = buffer.indexOf('\n')
      }
    }

    const onEnd = () => {
      buffer += decoder.end()
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.length > 0) {
        this.onStderr(line)
      }
      buffer = ''
    }

    stream.on('data', onData)
    stream.on('end', onEnd)

    return () => {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
    }
  }
}
