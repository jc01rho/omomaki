import { describe, expect, test } from 'vitest'
import { createRpcTurnAdapter } from './rpc-event-adapter.js'

function textFromEvents(events: ReadonlyArray<{ type: string }>): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || event.type !== 'message.part.updated') {
      continue
    }
    if (!('properties' in event)) {
      continue
    }
    const properties = event.properties
    if (!properties || typeof properties !== 'object' || !('part' in properties)) {
      continue
    }
    const part = properties.part
    if (!part || typeof part !== 'object' || !('text' in part)) {
      continue
    }
    if (typeof part.text === 'string') {
      return part.text
    }
  }
  return ''
}

describe('createRpcTurnAdapter', () => {
  test('maps prompt text_delta agent_settled onto Discord-shaped events', () => {
    const adapter = createRpcTurnAdapter('omo_session_1')
    const started = adapter.startTurn('hello', 1000)
    const types = started.map((event) => event.type)
    expect(types).toContain('session.status')
    expect(types).toContain('message.updated')

    const user = started.find((event) => {
      return (
        event.type === 'message.updated' &&
        event.properties.info.role === 'user'
      )
    })
    if (user === undefined || user.type !== 'message.updated') {
      throw new Error('expected user message.updated')
    }
    const userId = user.properties.info.id

    const streamed = [
      ...adapter.feed({ type: 'text_delta', delta: 'RPC-OK-ONLY' }, 1001),
      ...adapter.feed({ type: 'agent_settled' }, 1002),
    ]
    const assistant = streamed.find((event) => {
      return (
        event.type === 'message.updated' &&
        event.properties.info.role === 'assistant'
      )
    })
    if (assistant === undefined || assistant.type !== 'message.updated') {
      throw new Error('expected assistant message.updated')
    }
    const assistantInfo = assistant.properties.info
    if (assistantInfo.role !== 'assistant') {
      throw new Error('expected assistant role')
    }
    expect(assistantInfo.parentID).toBe(userId)
    expect(textFromEvents(streamed)).toBe('RPC-OK-ONLY')
    expect(streamed.some((event) => event.type === 'session.idle')).toBe(true)
    const completed = streamed.find((event) => {
      return (
        event.type === 'message.updated' &&
        event.properties.info.role === 'assistant' &&
        typeof event.properties.info.time.completed === 'number'
      )
    })
    expect(completed).toBeDefined()
  })
})
