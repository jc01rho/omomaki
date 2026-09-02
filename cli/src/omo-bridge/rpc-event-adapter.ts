import crypto from 'node:crypto'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'

export type RpcStreamEvent = {
  readonly type: string
  readonly delta?: string
}

export type RpcTurnAdapter = {
  startTurn(prompt: string, nowMs: number): readonly OpenCodeEvent[]
  feed(event: RpcStreamEvent, nowMs: number): readonly OpenCodeEvent[]
  abort(nowMs: number): readonly OpenCodeEvent[]
}

type AdapterState = {
  userMessageId: string | undefined
  assistantMessageId: string | undefined
  partId: string | undefined
  text: string
  started: boolean
  completed: boolean
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function eventId(): string {
  return newId('evt')
}

function statusEvent(
  sessionId: string,
  status: 'busy' | 'idle',
): OpenCodeEvent {
  return {
    id: eventId(),
    type: 'session.status',
    properties: {
      sessionID: sessionId,
      status: { type: status },
    },
  }
}

function idleEvent(sessionId: string): OpenCodeEvent {
  return {
    id: eventId(),
    type: 'session.idle',
    properties: {
      sessionID: sessionId,
    },
  }
}

function userMessageEvent(opts: {
  sessionId: string
  messageId: string
  created: number
}): OpenCodeEvent {
  return {
    id: eventId(),
    type: 'message.updated',
    properties: {
      sessionID: opts.sessionId,
      info: {
        id: opts.messageId,
        sessionID: opts.sessionId,
        role: 'user',
        time: { created: opts.created },
        agent: 'build',
        model: {
          providerID: 'omo',
          modelID: 'omo-rpc',
        },
      },
    },
  }
}

function assistantMessageEvent(opts: {
  sessionId: string
  messageId: string
  parentId: string
  created: number
  completed?: number
  finish?: 'stop'
}): OpenCodeEvent {
  return {
    id: eventId(),
    type: 'message.updated',
    properties: {
      sessionID: opts.sessionId,
      info: {
        id: opts.messageId,
        sessionID: opts.sessionId,
        role: 'assistant',
        parentID: opts.parentId,
        time: {
          created: opts.created,
          ...(opts.completed !== undefined ? { completed: opts.completed } : {}),
        },
        modelID: 'omo-rpc',
        providerID: 'omo',
        mode: 'build',
        agent: 'build',
        path: { cwd: '', root: '' },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        ...(opts.finish !== undefined ? { finish: opts.finish } : {}),
      },
    },
  }
}

function textPartEvent(opts: {
  sessionId: string
  messageId: string
  partId: string
  text: string
  ended: boolean
  nowMs: number
}): OpenCodeEvent {
  return {
    id: eventId(),
    type: 'message.part.updated',
    properties: {
      sessionID: opts.sessionId,
      time: opts.nowMs,
      part: {
        id: opts.partId,
        sessionID: opts.sessionId,
        messageID: opts.messageId,
        type: 'text',
        text: opts.text,
        time: opts.ended
          ? { start: opts.nowMs, end: opts.nowMs }
          : { start: opts.nowMs },
      },
    },
  }
}

function stepEvent(opts: {
  sessionId: string
  messageId: string
  kind: 'step-start' | 'step-finish'
  nowMs: number
}): OpenCodeEvent {
  if (opts.kind === 'step-start') {
    return {
      id: eventId(),
      type: 'message.part.updated',
      properties: {
        sessionID: opts.sessionId,
        time: opts.nowMs,
        part: {
          id: newId('prt'),
          sessionID: opts.sessionId,
          messageID: opts.messageId,
          type: 'step-start',
          snapshot: '',
        },
      },
    }
  }
  return {
    id: eventId(),
    type: 'message.part.updated',
    properties: {
      sessionID: opts.sessionId,
      time: opts.nowMs,
      part: {
        id: newId('prt'),
        sessionID: opts.sessionId,
        messageID: opts.messageId,
        type: 'step-finish',
        reason: 'stop',
        snapshot: '',
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  }
}

export function createRpcTurnAdapter(sessionId: string): RpcTurnAdapter {
  const state: AdapterState = {
    userMessageId: undefined,
    assistantMessageId: undefined,
    partId: undefined,
    text: '',
    started: false,
    completed: false,
  }

  const beginAssistant = (nowMs: number): OpenCodeEvent[] => {
    if (state.started || state.userMessageId === undefined) {
      return []
    }
    state.started = true
    state.assistantMessageId = newId('msg')
    state.partId = newId('prt')
    const assistantId = state.assistantMessageId
    return [
      assistantMessageEvent({
        sessionId,
        messageId: assistantId,
        parentId: state.userMessageId,
        created: nowMs,
      }),
      stepEvent({
        sessionId,
        messageId: assistantId,
        kind: 'step-start',
        nowMs,
      }),
    ]
  }

  const completeTurn = (nowMs: number): OpenCodeEvent[] => {
    if (state.completed || state.userMessageId === undefined) {
      return [statusEvent(sessionId, 'idle'), idleEvent(sessionId)]
    }
    state.completed = true
    const events: OpenCodeEvent[] = []
    if (!state.started) {
      events.push(...beginAssistant(nowMs))
    }
    const assistantId = state.assistantMessageId
    const partId = state.partId
    if (assistantId !== undefined && partId !== undefined && state.text.length > 0) {
      events.push(
        textPartEvent({
          sessionId,
          messageId: assistantId,
          partId,
          text: state.text,
          ended: true,
          nowMs,
        }),
      )
    }
    if (assistantId !== undefined) {
      events.push(
        stepEvent({
          sessionId,
          messageId: assistantId,
          kind: 'step-finish',
          nowMs,
        }),
        assistantMessageEvent({
          sessionId,
          messageId: assistantId,
          parentId: state.userMessageId,
          created: nowMs,
          completed: nowMs,
          finish: 'stop',
        }),
      )
    }
    events.push(statusEvent(sessionId, 'idle'), idleEvent(sessionId))
    return events
  }

  const abortTurn = (): OpenCodeEvent[] => {
    state.completed = true
    return [statusEvent(sessionId, 'idle'), idleEvent(sessionId)]
  }

  return {
    startTurn(_prompt: string, nowMs: number): readonly OpenCodeEvent[] {
      state.userMessageId = newId('msg')
      state.assistantMessageId = undefined
      state.partId = undefined
      state.text = ''
      state.started = false
      state.completed = false
      return [
        statusEvent(sessionId, 'busy'),
        userMessageEvent({
          sessionId,
          messageId: state.userMessageId,
          created: nowMs,
        }),
      ]
    },
    feed(event: RpcStreamEvent, nowMs: number): readonly OpenCodeEvent[] {
      if (state.completed) {
        return []
      }
      switch (event.type) {
        case 'text_delta': {
          const delta = event.delta ?? ''
          const events = beginAssistant(nowMs)
          state.text += delta
          const assistantId = state.assistantMessageId
          const partId = state.partId
          if (assistantId === undefined || partId === undefined) {
            return events
          }
          events.push(
            textPartEvent({
              sessionId,
              messageId: assistantId,
              partId,
              text: state.text,
              ended: false,
              nowMs,
            }),
          )
          return events
        }
        case 'text_end': {
          if (!state.started) {
            return []
          }
          const assistantId = state.assistantMessageId
          const partId = state.partId
          if (assistantId === undefined || partId === undefined) {
            return []
          }
          return [
            textPartEvent({
              sessionId,
              messageId: assistantId,
              partId,
              text: state.text,
              ended: true,
              nowMs,
            }),
          ]
        }
        case 'agent_start':
        case 'text_start':
        case 'message_start':
          return beginAssistant(nowMs)
        case 'agent_settled':
          return completeTurn(nowMs)
        case 'message_end':
          return []
        default:
          return []
      }
    },
    abort(_nowMs: number): readonly OpenCodeEvent[] {
      return abortTurn()
    },
  }
}
