#!/usr/bin/env node
// Fake classic `omo --mode rpc` child for OmoRpcClient unit tests.
//
// Protocol (LF JSONL, no readline):
// - stdin: one JSON object per \n-terminated line.
// - stdout: responses and events as JSON objects, one per \n.
// - stderr: plain text logs, never JSON.
//
// Commands:
// - prompt {id, message}: success response, then agent_start, text_start,
//   text_delta "RPC-OK-ONLY", text_end, message_end, agent_settled.
//   If message includes "touch-denied", emit extension_ui_request confirm
//   instead and wait for extension_ui_response before settling.
// - abort {id}: success + agent_settled.
// - get_protocol_info {id}: classic mode info.
// - get_state {id}: {isSettled:true}.
// - get_messages {id}: one user message.
// - get_loaded_surfaces {id}: MCP-like status payload.
// - navigate_tree {id, targetId}: success + {cancelled:false} (used by
//   session.revert/unrevert shim mapping).

import { StringDecoder } from 'node:string_decoder'

const decoder = new StringDecoder('utf8')
let buffer = ''
/** @type {Map<string, {id: string}>} */
const pendingConfirms = new Map()

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function handleRecord(line) {
  if (line.trim().length === 0) return
  let frame
  try {
    frame = JSON.parse(line)
  } catch (error) {
    process.stderr.write(`fake-rpc: bad json: ${String(error)}\n`)
    return
  }

  if (frame.type === 'extension_ui_response') {
    const pending = pendingConfirms.get(frame.id)
    if (!pending) return
    pendingConfirms.delete(frame.id)
    send({
      type: 'response',
      command: 'prompt',
      id: pending.id,
      success: true,
      confirmed: frame.confirmed === true,
      cancelled: frame.cancelled === true,
    })
    send({ type: 'agent_settled' })
    return
  }

  const id = frame.id
  const type = frame.type

  if (type === 'get_protocol_info') {
    send({
      id,
      type: 'response',
      command: 'get_protocol_info',
      success: true,
      data: {
        protocolVersion: 1,
        serverVersion: 'fake',
        capabilities: [],
        mode: 'classic',
      },
    })
    return
  }

  if (type === 'get_state') {
    send({
      id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { isSettled: true, followUpMessages: [], steerPrompt: null },
    })
    return
  }

  if (type === 'abort') {
    send({ id, type: 'response', command: 'abort', success: true })
    send({ type: 'agent_settled' })
    return
  }

  if (type === 'steer' || type === 'follow_up') {
    send({ id, type: 'response', command: type, success: true })
    return
  }

  if (type === 'get_commands') {
    send({
      id,
      type: 'response',
      command: 'get_commands',
      success: true,
      data: {
        commands: [{ name: 'build', description: 'Build command', source: 'prompt' }],
      },
    })
    return
  }

  if (type === 'get_available_models') {
    send({
      id,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [{ id: 'test-model', provider: 'omo', name: 'Test', contextWindow: 128000 }],
      },
    })
    return
  }

  if (type === 'get_loaded_surfaces') {
    send({
      id,
      type: 'response',
      command: 'get_loaded_surfaces',
      success: true,
      data: {
        mcpServers: [
          { name: 'connected-server', status: 'connected' },
          { name: 'enabled-server', status: 'enabled' },
          { name: 'disabled-server', status: 'disabled' },
          { name: 'failed-server', status: 'failed' },
        ],
      },
    })
    return
  }

  if (type === 'get_messages') {
    send({
      id,
      type: 'response',
      command: 'get_messages',
      success: true,
      data: {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'hello',
            timestamp: '2026-09-02T00:00:00.000Z',
          },
        ],
      },
    })
    return
  }

  if (type === 'compact' || type === 'clone' || type === 'fork' || type === 'navigate_tree') {
    send({ id, type: 'response', command: type, success: true, data: { cancelled: false } })
    return
  }

  if (type === 'prompt') {
    const message = typeof frame.message === 'string' ? frame.message : ''
    if (message.includes('touch-denied')) {
      const confirmId = 'confirm-1'
      pendingConfirms.set(confirmId, { id })
      send({
        type: 'extension_ui_request',
        id: confirmId,
        method: 'confirm',
        title: 'omomaki approval',
        message: 'Allow bash: touch should-not-exist',
        timeout: 60000,
      })
      return
    }
    send({ id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_start' })
    send({ type: 'message_start' })
    send({ type: 'text_start' })
    send({ type: 'text_delta', delta: 'RPC-OK-ONLY' })
    send({ type: 'text_end' })
    send({ type: 'message_end' })
    send({ type: 'agent_settled' })
    return
  }

  send({
    id,
    type: 'response',
    command: type ?? 'unknown',
    success: true,
    echoed: type,
  })
}

process.stderr.write('fake-rpc: starting\n')

process.stdin.on('data', (chunk) => {
  buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
  let lineStart = 0
  let newlineIndex = buffer.indexOf('\n', lineStart)
  while (newlineIndex !== -1) {
    const lineEnd =
      newlineIndex > lineStart && buffer.charCodeAt(newlineIndex - 1) === 0x0d
        ? newlineIndex - 1
        : newlineIndex
    handleRecord(buffer.slice(lineStart, lineEnd))
    lineStart = newlineIndex + 1
    newlineIndex = buffer.indexOf('\n', lineStart)
  }
  buffer = lineStart === 0 ? buffer : buffer.slice(lineStart)
})

process.stdin.on('end', () => {
  buffer += decoder.end()
  if (buffer.length > 0) {
    handleRecord(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
  }
})
