import { promises as fs } from 'node:fs'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'

/**
 * Live-follow for resumed omo sessions.
 *
 * When /resume opens an omo session that is actively running elsewhere, the
 * external omo process appends new entries to the shared session file. kimaki's
 * own omo RPC child does not see those appends (verified: get_entries returned
 * the same count until `reload` is issued). This module polls the session file
 * for new entries, reloads the RPC child so its in-memory state stays in sync,
 * and dispatches OpenCode events for every newly appended message so the
 * Discord thread keeps showing the ongoing conversation.
 */

const DEFAULT_POLL_MS = 3_000

export type LiveFollowHost = {
  /**
   * Deliver OpenCode events to the runtime (dispatch path).
   */
  dispatch(event: OpenCodeEvent): Promise<void>
  /**
   * Ask the omo RPC child to reload the session file from disk so its
   * in-memory state includes externally appended entries.
   */
  reload(): Promise<unknown>
}

export type LiveFollowController = {
  stop(): void
  readonly threadId: string
}

type LiveFollowOptions = {
  threadId: string
  sessionFile: string
  host: LiveFollowHost
  pollMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (isRecord(part) && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  if (isRecord(content) && typeof content.text === 'string') return content.text
  return ''
}

function toEventId(seed: string, kind: string): string {
  return `evt_${Buffer.from(seed).toString('hex').slice(0, 20)}_${kind}`
}

/**
 * Convert raw omo session-file entries into OpenCode events the kimaki runtime
 * renders as bot messages (message.updated + message.part.updated text).
 */
export function omoFileEntriesToEvents(
  entries: unknown[],
  opts: { directory: string },
): OpenCodeEvent[] {
  const directory = opts.directory
  const events: OpenCodeEvent[] = []

  for (const raw of entries) {
    if (!isRecord(raw)) continue
    if (raw.type !== 'message') continue
    const message = isRecord(raw.message) ? raw.message : {}
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const id = typeof raw.id === 'string' ? raw.id : `entry_${events.length}`
    const created =
      typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Date.now()
    const text = textFromContent(message.content)
    const sessionID = typeof message.session_id === 'string' ? message.session_id : 'session'
    const partId = `${id}_text`

    // session.layout/message.updated — tell the runtime a message exists.
    const nowMs = Number.isFinite(created) ? created : Date.now()
    events.push({
      id: toEventId(id, 'updated'),
      type: 'message.updated',
      properties: {
        sessionID,
        info: {
          id,
          sessionID,
          role,
          time: { created: nowMs },
          agent: 'build',
          model: { providerID: 'omo', modelID: 'default' },
        },
      },
    } as OpenCodeEvent)

    if (!text) continue

    events.push({
      id: toEventId(id, 'part'),
      type: 'message.part.updated',
      properties: {
        sessionID,
        time: nowMs,
        part: {
          id: partId,
          sessionID,
          messageID: id,
          type: 'text',
          text,
        },
      },
    } as OpenCodeEvent)
  }

  return events
}

async function readFileLines(file: string): Promise<string[]> {
  try {
    const content = await fs.readFile(file, 'utf8')
    return content.split('\n').filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

function parseEntry(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * Stop a live-follow loop by thread id. No-op when none is running.
 */
export function stopLiveFollow(threadId: string): void {
  followRegistry.get(threadId)?.stop()
  followRegistry.delete(threadId)
}

const followRegistry = new Map<string, LiveFollowController>()

/**
 * Register a controller so stopLiveFollow can find it by thread id.
 */
export function registerLiveFollow(controller: LiveFollowController): void {
  followRegistry.set(controller.threadId, controller)
}

/**
 * Start a polling loop that tails `sessionFile` and dispatches events for each
 * newly appended entry. Returns a controller with stop().
 */
export function startLiveFollow(options: LiveFollowOptions): LiveFollowController {
  const { threadId, sessionFile, host } = options
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS

  let lastSeenCount = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // Initialize the baseline: everything already in the file at start is
  // history the resume snapshot already replayed — never re-dispatch it.
  const initPromise = readFileLines(sessionFile).then((lines) => {
    if (!stopped) lastSeenCount = lines.length
  })

  async function poll(): Promise<void> {
    if (stopped) return
    const lines = await readFileLines(sessionFile)
    if (lines.length > lastSeenCount) {
      const newLines = lines.slice(lastSeenCount)
      lastSeenCount = lines.length

      // Reload the omo child so its in-memory state includes the externals
      // (the child cannot see them otherwise), then dispatch their events.
      try {
        await host.reload()
      } catch {
        // reload failure should not block dispatching the entries we did read
      }
      const entries = newLines.map(parseEntry).filter((e): e is unknown => e !== null)
      const events = omoFileEntriesToEvents(entries, {
        directory: sessionFile,
      })
      for (const event of events) {
        if (stopped) break
        try {
          await host.dispatch(event)
        } catch {
          // a dispatch failure must not kill the poller
        }
      }
    }
  }

  void initPromise.then(() => {
    if (stopped) return
    timer = setInterval(() => {
      void poll()
    }, pollMs)
  })

  const controller: LiveFollowController = {
    threadId,
    stop() {
      stopped = true
      followRegistry.delete(threadId)
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
  followRegistry.set(threadId, controller)
  return controller
}