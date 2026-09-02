import path from 'node:path'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { getDb } from '../db.js'
import { getThreadIdBySessionId } from '../database.js'
import type { OmoRpcClient } from './rpc-client.js'
import {
  getLiveRpcClient,
  getOrStartRpcSession,
  stopAllRpcSessions,
} from './rpc-session.js'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function emptyResponse(): Response {
  return new Response(null, { status: 200 })
}

function emptyRequest(): Request {
  return new Request('http://omo-rpc.local/')
}

function okResult<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: emptyRequest(),
    response: emptyResponse(),
  })
}

function errResult(message: string) {
  return Promise.resolve({
    data: undefined,
    error: { message },
    request: emptyRequest(),
    response: emptyResponse(),
  })
}

function stubModel(opts: {
  id: string
  providerID: string
  name?: string
  context?: number
}) {
  return {
    id: opts.id,
    providerID: opts.providerID,
    api: { id: 'omo', url: '', npm: '' },
    name: opts.name ?? opts.id,
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: opts.context ?? 200_000,
      output: 32_000,
    },
    status: 'active' as const,
    options: {},
    headers: {},
    release_date: '',
  }
}

function stubSession(opts: {
  id: string
  directory: string
  title?: string
  created?: number
}) {
  const now = opts.created ?? Date.now()
  return {
    id: opts.id,
    slug: opts.id,
    projectID: opts.directory,
    directory: opts.directory,
    title: opts.title ?? opts.id,
    version: 'omo-rpc',
    time: { created: now, updated: now },
  }
}

function commandSource(
  source: string | undefined,
): 'command' | 'mcp' | 'skill' {
  if (source === 'skill') return 'skill'
  if (source === 'mcp' || source === 'extension') return 'mcp'
  return 'command'
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (isRecord(part) && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  if (isRecord(value) && typeof value.text === 'string') return value.text
  return ''
}

function mapRpcMessage(raw: unknown, sessionID: string, directory: string) {
  const record = isRecord(raw) ? raw : {}
  const nested = isRecord(record.message) ? record.message : record
  const role = nested.role === 'assistant' ? 'assistant' : 'user'
  const id = asString(nested.id ?? record.id, `msg_${sessionID}`)
  const created = Date.parse(asString(nested.timestamp ?? record.timestamp)) || Date.now()
  const content = nested.content ?? nested.text ?? record.content
  const text = textFromUnknown(content)
  const providerID = asString(
    nested.provider ?? nested.providerID,
    'omo',
  )
  const modelID = asString(nested.modelId ?? nested.modelID, 'default')
  const parts = text
    ? [
        {
          id: `${id}_text`,
          sessionID,
          messageID: id,
          type: 'text' as const,
          text,
        },
      ]
    : []

  if (role === 'assistant') {
    return {
      info: {
        id,
        sessionID,
        role: 'assistant' as const,
        time: { created },
        parentID: asString(nested.parentId ?? nested.parentID, id),
        modelID,
        providerID,
        mode: 'build',
        agent: asString(nested.agent, 'build'),
        path: { cwd: directory, root: directory },
        cost: asNumber(nested.cost),
        tokens: {
          input: asNumber(isRecord(nested.usage) ? nested.usage.input : 0),
          output: asNumber(isRecord(nested.usage) ? nested.usage.output : 0),
          reasoning: asNumber(isRecord(nested.usage) ? nested.usage.reasoning : 0),
          cache: {
            read: asNumber(isRecord(nested.usage) ? nested.usage.cacheRead : 0),
            write: asNumber(isRecord(nested.usage) ? nested.usage.cacheWrite : 0),
          },
        },
      },
      parts,
    }
  }

  return {
    info: {
      id,
      sessionID,
      role: 'user' as const,
      time: { created },
      agent: asString(nested.agent, 'build'),
      model: { providerID, modelID },
    },
    parts,
  }
}

async function lookupThreadId(sessionId: string): Promise<string | null> {
  return (await getThreadIdBySessionId(sessionId)) ?? null
}

async function listBoundSessions(directory: string) {
  const db = await getDb()
  const rows = await db.query.thread_sessions.findMany({
    columns: { thread_id: true, session_id: true, created_at: true, updated_at: true },
  })
  return rows.map((row) => {
    const created = row.created_at?.getTime() ?? Date.now()
    return stubSession({
      id: row.session_id,
      directory,
      created,
    })
  })
}

async function withRpcClient<T>(
  directory: string,
  sessionId: string | undefined,
  run: (client: OmoRpcClient, threadId: string) => Promise<T>,
): Promise<T> {
  if (sessionId) {
    const threadId = await lookupThreadId(sessionId)
    if (!threadId) {
      // /resume may bind a session to a new thread; an unbound session cannot
      // be routed to any omo process. Fail closed rather than spawning an
      // ephemeral metadata session that would answer against the wrong thread.
      throw new Error(`no thread bound for session ${sessionId}`)
    }
    const live = getLiveRpcClient(threadId)
    if (live) return run(live, threadId)
    const handle = await getOrStartRpcSession({
      threadId,
      cwd: directory,
      dispatch: async () => {},
    })
    const started = getLiveRpcClient(threadId)
    if (!started) {
      throw new Error(`omo rpc session missing after start for ${threadId}`)
    }
    void handle
    return run(started, threadId)
  }

  const ephemeralThread = `rpc-meta-${directory.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-24)}`
  const handle = await getOrStartRpcSession({
    threadId: ephemeralThread,
    cwd: directory,
    dispatch: async () => {},
  })
  const started = getLiveRpcClient(ephemeralThread)
  if (!started) {
    throw new Error('omo rpc metadata session failed to start')
  }
  void handle
  return run(started, ephemeralThread)
}

async function getOrStartRpcClientForThread(
  directory: string,
  threadId: string,
): Promise<OmoRpcClient | null> {
  const live = getLiveRpcClient(threadId)
  if (live) {
    return live
  }

  const handle = await getOrStartRpcSession({
    threadId,
    cwd: directory,
    dispatch: async () => {},
  })
  const started = getLiveRpcClient(threadId)
  void handle
  return started
}

function getMessageIdFromRpcMessage(raw: unknown): string {
  const record = isRecord(raw) ? raw : {}
  const nested = isRecord(record.message) ? record.message : record
  return asString(nested.id ?? nested.messageId)
}

function getLatestMessageId(payload: unknown): string {
  const list = isRecord(payload) ? asArray(payload.messages) : asArray(payload)
  const last = list.at(-1)
  return getMessageIdFromRpcMessage(last)
}

function unwrapErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invalidSessionError(method: string): string {
  return `${method}: no thread bound for this session`
}

function failedToStartThread(method: string, threadId: string): string {
  return `${method}: failed to start rpc client for thread ${threadId}`
}

// Revert cursor per session id. persist the last /undo navigate_tree target so
// /redo and a second /undo can resolve the current revert point from get().
const revertCursors = new Map<string, { messageID: string }>()

function createShim(directory: string): OpencodeClient {
  const session = {
    async list() {
      return okResult(await listBoundSessions(directory))
    },
    async get(params: { sessionID?: string } = {}) {
      const sessionID = params.sessionID
      if (!sessionID) return errResult('sessionID required')
      const threadId = await lookupThreadId(sessionID)
      if (!threadId) return errResult('Session not found')
      const revert = revertCursors.get(sessionID)
      return okResult(
        revert
          ? { ...stubSession({ id: sessionID, directory }), revert }
          : stubSession({ id: sessionID, directory }),
      )
    },
    async create() {
      const threadId = `created-${Date.now()}`
      const handle = await getOrStartRpcSession({
        threadId,
        cwd: directory,
        dispatch: async () => {},
      })
      return okResult(stubSession({ id: handle.sessionId, directory }))
    },
    async update(params: { sessionID?: string; title?: string } = {}) {
      if (params.sessionID && params.title) {
        await withRpcClient(directory, params.sessionID, (client) => {
          return client.request('set_session_name', { name: params.title })
        }).catch(() => undefined)
      }
      return okResult(
        stubSession({
          id: params.sessionID ?? 'unknown',
          directory,
          title: params.title,
        }),
      )
    },
    async messages(params: { sessionID?: string } = {}) {
      const sessionID = params.sessionID
      if (!sessionID) return errResult('sessionID required')
      const data = await withRpcClient(directory, sessionID, async (client) => {
        const payload = await client.request('get_messages')
        const messages = isRecord(payload) ? asArray(payload.messages) : asArray(payload)
        return messages.map((message) => mapRpcMessage(message, sessionID, directory))
      })
      return okResult(data)
    },
    async status(params: { sessionID?: string } = {}) {
      if (!params.sessionID) return okResult({})
      const data = await withRpcClient(directory, params.sessionID, async (client) => {
        const state = await client.request('get_state')
        const streaming =
          isRecord(state) &&
          (state.isStreaming === true || state.isSettled === false)
        return {
          [params.sessionID as string]: {
            type: streaming ? 'busy' : 'idle',
          },
        }
      })
      return okResult(data)
    },
    async abort(params: { sessionID?: string } = {}) {
      await withRpcClient(directory, params.sessionID, (client) => {
        return client.request('abort')
      }).catch(() => undefined)
      return okResult(true)
    },
    async promptAsync() {
      return errResult('use submitViaOmoRpc for prompts')
    },
    async command(params: {
      command?: string
      arguments?: string
      sessionID?: string
    } = {}) {
      const name = asString(params.command)
      const args = asString(params.arguments)
      const prompt = args ? `/${name} ${args}` : `/${name}`
      await withRpcClient(directory, params.sessionID, async (client) => {
        await client.prompt(prompt)
        await client.waitForSettled()
      })
      return okResult({ info: { id: params.sessionID ?? 'unknown' }, parts: [] })
    },
    async summarize(params: { sessionID?: string } = {}) {
      await withRpcClient(directory, params.sessionID, (client) => {
        return client.request('compact')
      })
      return okResult(true)
    },
    async fork(params: { sessionID?: string; messageID?: string } = {}) {
      const data = await withRpcClient(directory, params.sessionID, async (client) => {
        if (params.messageID) {
          await client.request('fork', { entryId: params.messageID })
        } else {
          await client.request('clone')
        }
        const state = await client.request('get_state')
        const id =
          isRecord(state) && typeof state.sessionId === 'string' && state.sessionId.length > 0
            ? state.sessionId
            : `${params.sessionID ?? 'session'}_fork`
        return stubSession({ id, directory })
      })
      return okResult(data)
    },
    async revert(params: { sessionID?: string; messageID?: string } = {}) {
      const sessionID = params.sessionID
      const messageID = params.messageID
      if (!sessionID || !messageID) {
        return errResult('sessionID and messageID required for session.revert')
      }
      const threadId = await lookupThreadId(sessionID)
      if (!threadId) {
        return errResult(invalidSessionError('session.revert'))
      }

      const live = await getOrStartRpcClientForThread(directory, threadId)
      if (!live) {
        return errResult(failedToStartThread('session.revert', threadId))
      }

      try {
        await live.request('navigate_tree', { targetId: messageID })
      } catch (error) {
        return errResult(`session.revert failed: ${unwrapErrorMessage(error)}`)
      }

      revertCursors.set(sessionID, { messageID })

      return okResult({
        ...stubSession({ id: sessionID, directory }),
        revert: { messageID },
      })
    },
    async unrevert(params: { sessionID?: string } = {}) {
      const sessionID = params.sessionID
      if (!sessionID) {
        return errResult('sessionID required for session.unrevert')
      }

      const threadId = await lookupThreadId(sessionID)
      if (!threadId) {
        return errResult(invalidSessionError('session.unrevert'))
      }

      const live = await getOrStartRpcClientForThread(directory, threadId)
      if (!live) {
        return errResult(failedToStartThread('session.unrevert', threadId))
      }

      try {
        const messages = await live.request('get_messages')
        const targetId = getLatestMessageId(messages)
        if (!targetId) {
          return errResult(
            'session.unrevert failed: unable to resolve latest message for forward navigation',
          )
        }
        await live.request('navigate_tree', { targetId })
      } catch (error) {
        return errResult(`session.unrevert failed: ${unwrapErrorMessage(error)}`)
      }

      revertCursors.delete(sessionID)
      return okResult(stubSession({ id: sessionID, directory }))
    },
    async share() {
      return errResult('session.share is not supported on omo RPC')
    },
    async trim() {
      return errResult('session.trim is not supported on omo RPC')
    },
  }

  const provider = {
    async list() {
      const data = await withRpcClient(directory, undefined, async (client) => {
        const payload = await client.request('get_available_models')
        const models = isRecord(payload) ? asArray(payload.models) : asArray(payload)
        const grouped = new Map<string, ReturnType<typeof stubModel>[]>()
        for (const raw of models) {
          if (!isRecord(raw)) continue
          const providerID = asString(raw.provider ?? raw.providerID, 'omo')
          const id = asString(raw.id ?? raw.modelId, 'default')
          const list = grouped.get(providerID) ?? []
          list.push(
            stubModel({
              id,
              providerID,
              name: asString(raw.name, id),
              context: asNumber(raw.contextWindow, 200_000),
            }),
          )
          grouped.set(providerID, list)
        }
        const all = [...grouped.entries()].map(([id, modelList]) => ({
          id,
          name: id,
          source: 'env' as const,
          env: [],
          options: {},
          models: Object.fromEntries(modelList.map((model) => [model.id, model])),
        }))
        return {
          all,
          connected: all.map((item) => item.id),
          default: Object.fromEntries(
            all.map((item) => [item.id, Object.keys(item.models)[0] ?? '']),
          ),
        }
      })
      return okResult(data)
    },
    async auth() {
      return errResult('provider.auth is not supported on omo RPC')
    },
    oauth: {
      async authorize() {
        return errResult(
          'provider.oauth.authorize is not supported on omo RPC; use omo login_start instead',
        )
      },
    },
  }

  const command = {
    async list() {
      const data = await withRpcClient(directory, undefined, async (client) => {
        const payload = await client.request('get_commands')
        const commands = isRecord(payload) ? asArray(payload.commands) : asArray(payload)
        return commands.map((raw) => {
          const record = isRecord(raw) ? raw : {}
          const name = asString(record.name)
          return {
            name,
            description: asString(record.description, name),
            source: commandSource(asString(record.source)),
            template: `/${name} $ARGUMENTS`,
            hints: [],
          }
        })
      })
      return okResult(data)
    },
  }

  const app = {
    async agents() {
      return okResult([
        {
          name: 'build',
          description: 'Default omo agent',
          mode: 'primary' as const,
          hidden: false,
          permission: {},
          options: {},
        },
      ])
    },
  }

  const mcp = {
    async status() {
      const data = await withRpcClient(directory, undefined, async (client) => {
        const payload = await client.request('get_loaded_surfaces')
        const servers = isRecord(payload) ? asArray(payload.mcpServers) : []
        const mapped: Record<string, { status: 'connected' | 'disabled' | 'failed' }> = {}
        for (const raw of servers) {
          if (!isRecord(raw)) continue
          const name = asString(raw.name)
          const status = asString(raw.status)
          mapped[name] = {
            status:
              status === 'connected' || status === 'enabled'
                ? 'connected'
                : status === 'disabled'
                  ? 'disabled'
                  : 'failed',
          }
        }
        return mapped
      })
      return okResult(data)
    },
    async connect() {
      return errResult('mcp.connect is not supported on omo RPC')
    },
    async disconnect() {
      return errResult('mcp.disconnect is not supported on omo RPC')
    },
  }

  const config = {
    async get() {
      return okResult({})
    },
    async providers() {
      const listed = await provider.list()
      return okResult({
        providers: listed.data?.all ?? [],
        default: listed.data?.default ?? {},
      })
    },
  }

  const project = {
    async list() {
      return okResult([
        {
          id: directory,
          worktree: directory,
          vcs: 'git' as const,
          name: path.basename(directory),
          time: { created: Date.now(), updated: Date.now() },
          sandboxes: [],
        },
      ])
    },
  }

  const permission = {
    async reply() {
      return okResult(true)
    },
  }

  return {
    session,
    provider,
    command,
    app,
    mcp,
    config,
    project,
    permission,
  } as unknown as OpencodeClient
}

const shims = new Map<string, OpencodeClient>()

export function getOmoRpcOpencodeClient(directory: string): OpencodeClient {
  const existing = shims.get(directory)
  if (existing) return existing
  const created = createShim(directory)
  shims.set(directory, created)
  return created
}

export async function restartOmoRpcRuntime(): Promise<void> {
  await stopAllRpcSessions()
  shims.clear()
}
