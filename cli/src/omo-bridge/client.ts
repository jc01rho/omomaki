// JSON-RPC stdio client for `omo app-server`.
//
// Wire protocol (verified against a real omo app-server process):
// - LF-delimited JSON frames on stdout (request/response/notification).
// - Plain-text log lines on stderr — never parsed as protocol frames.
// - `initialize` MUST be the first request sent; anything sent before it
//   is rejected by the server with error code -32000.
// - The server may push notifications (method+params+emittedAtMs, no id)
//   and server-requests (approval prompts — a JsonRpcRequest sent by the
//   server that must be answered via replyToServerRequest).
//
// This client owns a small state machine (ClientState) so callers can tell
// "not started yet" apart from "mid-handshake" apart from "usable".

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type {
  ApprovalServerRequest,
  ClientState,
  JsonRpcNotification,
  JsonRpcRequestId,
  JsonRpcResponse,
  JsonRpcServerRequest,
  ThreadForkParams,
  ThreadRecord,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
} from './types.js'

const DEFAULT_COMMAND = 'omo'
const DEFAULT_ARGS = ['app-server', '--listen', 'stdio://']
const FORCE_KILL_TIMEOUT_MS = 3_000

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

// Any frame the server can send us on stdout. Responses carry an id that
// matches something we sent; requests carry an id the server picked;
// notifications carry neither.
type IncomingFrame =
  | JsonRpcResponse
  | JsonRpcServerRequest
  | JsonRpcNotification

export type OmoAppServerClientOptions = {
  command?: string
  args?: string[]
  cwd?: string
  stderr?: (line: string) => void
  onNotification?: (notification: JsonRpcNotification) => void
  onServerRequest?: (request: ApprovalServerRequest) => void
  autoRestart?: boolean
}

function isResponseFrame(frame: IncomingFrame): frame is JsonRpcResponse {
  return (
    'id' in frame &&
    frame.id !== undefined &&
    ('result' in frame || 'error' in frame)
  )
}

function isServerRequestFrame(
  frame: IncomingFrame,
): frame is JsonRpcServerRequest {
  return 'id' in frame && frame.id !== undefined && 'method' in frame
}

export class OmoAppServerClient {
  private readonly command: string
  private readonly args: string[]
  private readonly cwd: string | undefined
  private readonly onStderr: (line: string) => void
  private readonly onNotification: (notification: JsonRpcNotification) => void
  private readonly onServerRequest: (request: ApprovalServerRequest) => void
  private readonly autoRestart: boolean

  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutReader: readline.Interface | null = null
  private stderrReader: readline.Interface | null = null
  private state: ClientState = 'stopped'
  private nextId = 1
  private readonly pending = new Map<JsonRpcRequestId, PendingRequest>()
  private readonly trackedThreadIds = new Set<string>()
  private restarting = false

  constructor(options: OmoAppServerClientOptions = {}) {
    const args = options.args ?? DEFAULT_ARGS
    const listenArg = args.find((arg) => arg.startsWith('--listen'))
    if (listenArg) {
      const value = listenArg.includes('=')
        ? listenArg.slice(listenArg.indexOf('=') + 1)
        : args[args.indexOf(listenArg) + 1]
      if (value !== 'stdio://') {
        throw new Error(
          `OmoAppServerClient only supports stdio transport, got listen target: ${String(value)}`,
        )
      }
    }

    this.command = options.command ?? DEFAULT_COMMAND
    this.args = args
    this.cwd = options.cwd
    this.onStderr =
      options.stderr ?? ((line) => process.stderr.write(line + '\n'))
    this.onNotification = options.onNotification ?? (() => {})
    this.onServerRequest = options.onServerRequest ?? (() => {})
    this.autoRestart = options.autoRestart ?? true
  }

  getState(): ClientState {
    return this.state
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'failed') {
      throw new Error(`cannot start client from state: ${this.state}`)
    }
    this.state = 'spawning'
    this.spawnChild()
    this.state = 'initializing'
    await this.sendInitialize()
    this.state = 'ready'
  }

  private spawnChild(): void {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: 'pipe',
    })
    this.child = child

    this.stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })
    this.stdoutReader.on('line', (line) => this.handleLine(line))

    this.stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    })
    this.stderrReader.on('line', (line) => this.onStderr(line))

    child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal)
    })
  }

  private handleChildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const wasReady = this.state === 'ready' || this.state === 'initializing'
    this.stdoutReader?.close()
    this.stderrReader?.close()
    this.stdoutReader = null
    this.stderrReader = null
    this.child = null

    const error = new Error(
      `omo app-server exited unexpectedly (code=${code}, signal=${signal})`,
    )
    for (const [, pendingRequest] of this.pending) {
      pendingRequest.reject(error)
    }
    this.pending.clear()

    if (this.restarting) {
      // Exit was triggered by restart()/shutdown(); the caller drives the
      // next state transition.
      return
    }

    if (wasReady) {
      this.state = 'failed'
      if (this.autoRestart) {
        void this.restart().catch((restartError: unknown) => {
          this.onStderr(
            `omo-bridge: auto-restart failed: ${String(restartError)}`,
          )
        })
      }
    } else {
      this.state = 'failed'
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return
    let frame: IncomingFrame
    try {
      frame = JSON.parse(line) as IncomingFrame
    } catch (error) {
      this.onStderr(
        `omo-bridge: failed to parse stdout frame: ${String(error)}`,
      )
      return
    }

    if (isResponseFrame(frame)) {
      const pendingRequest = this.pending.get(frame.id)
      if (!pendingRequest) return
      this.pending.delete(frame.id)
      if ('error' in frame && frame.error) {
        pendingRequest.reject(
          Object.assign(
            new Error(`${frame.error.message} (code ${frame.error.code})`),
            { code: frame.error.code, data: frame.error.data },
          ),
        )
      } else {
        pendingRequest.resolve('result' in frame ? frame.result : undefined)
      }
      return
    }

    if (isServerRequestFrame(frame)) {
      this.onServerRequest({
        id: frame.id,
        method: frame.method,
        params: frame.params,
      })
      return
    }

    this.onNotification(frame)
  }

  private write(payload: object): void {
    if (!this.child?.stdin.writable) {
      throw new Error('omo app-server stdin is not writable')
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  private async sendInitialize(): Promise<void> {
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({
      id,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'omomaki',
          title: 'omomaki',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    })
    await result
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'ready') {
      throw new Error('not-ready:' + this.state)
    }
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ id, method, params })
    return result as Promise<T>
  }

  replyToServerRequest(id: JsonRpcRequestId, result: unknown): void {
    this.write({ id, result })
  }

  async startThread(params: ThreadStartParams): Promise<ThreadRecord> {
    return this.request<ThreadRecord>('thread/start', {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      ...params,
    })
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadRecord> {
    return this.request<ThreadRecord>('thread/resume', {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      ...params,
    })
  }

  async forkThread(params: ThreadForkParams): Promise<ThreadRecord> {
    return this.request<ThreadRecord>('thread/fork', {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      ...params,
    })
  }

  async startTurn(params: TurnStartParams): Promise<unknown> {
    return this.request('turn/start', params)
  }

  async interruptTurn(params: TurnInterruptParams): Promise<unknown> {
    return this.request('turn/interrupt', params)
  }

  async listLoadedThreads(): Promise<ThreadRecord[]> {
    return this.request<ThreadRecord[]>('thread/listLoaded')
  }

  async readThread(threadId: string): Promise<ThreadRecord> {
    return this.request<ThreadRecord>('thread/read', { threadId })
  }

  trackThread(threadId: string): void {
    this.trackedThreadIds.add(threadId)
  }

  async restart(): Promise<void> {
    this.restarting = true
    try {
      this.state = 'recovering'
      await this.killChild()
      this.spawnChild()
      this.state = 'initializing'
      await this.sendInitialize()
      this.state = 'ready'
    } finally {
      this.restarting = false
    }
  }

  async shutdown(): Promise<void> {
    for (const threadId of this.trackedThreadIds) {
      try {
        await this.request('thread/unsubscribe', { threadId })
      } catch {
        // Best-effort: the server may already be gone or the thread may
        // already be unsubscribed. Never let this block shutdown.
      }
    }
    this.trackedThreadIds.clear()
    this.restarting = true
    try {
      await this.killChild()
    } finally {
      this.restarting = false
    }
    this.state = 'stopped'
  }

  private async killChild(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const onExit = () => {
        if (settled) return
        settled = true
        clearTimeout(forceKillTimer)
        resolve()
      }
      child.once('exit', onExit)

      const forceKillTimer = setTimeout(() => {
        if (settled) return
        child.kill('SIGKILL')
      }, FORCE_KILL_TIMEOUT_MS)

      child.kill('SIGTERM')
    })
  }
}
