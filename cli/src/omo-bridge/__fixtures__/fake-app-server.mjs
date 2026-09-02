#!/usr/bin/env node
// Fake `omo app-server` for OmoAppServerClient unit tests.
//
// Protocol it implements on stdin/stdout (LF-delimited JSON):
// - Rejects every request with error -32000 until `initialize` has been
//   received and answered, matching the real server's initialize-first gate.
// - `initialize` -> replies with a minimal result.
// - `trigger/notification` -> emits a JsonRpcNotification (no id) instead of
//   a response.
// - `trigger/serverRequest` -> emits a JsonRpcServerRequest (its own id,
//   distinct from client ids) that the test is expected to answer via
//   replyToServerRequest; the fake logs the reply payload as a notification
//   so the test can observe the round trip.
// - `trigger/error` -> replies with a JSON-RPC error.
// - `trigger/exit` -> exits the process immediately (no response sent).
// - anything else, once initialized -> echoed back as `{ echoedMethod,
//   receivedParams }` in the result.
//
// Log lines written to stderr are plain text, never JSON — the client must
// never attempt to parse them as protocol frames.

import readline from 'node:readline'

let initialized = false
let serverRequestId = 1000

const rl = readline.createInterface({ input: process.stdin })

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

function sendError(id, code, message) {
  send({ id, error: { code, message } })
}

process.stderr.write('fake-app-server: starting\n')

rl.on('line', (line) => {
  if (line.trim().length === 0) return
  let frame
  try {
    frame = JSON.parse(line)
  } catch (error) {
    process.stderr.write(`fake-app-server: bad json: ${String(error)}\n`)
    return
  }

  const { id, method, params } = frame

  if (method === 'initialize') {
    initialized = true
    send({ id, result: { serverInfo: { name: 'fake-omo', version: '0.0.0' } } })
    return
  }

  if (!initialized) {
    sendError(id, -32000, 'server not initialized: call initialize first')
    return
  }

  if (method === 'trigger/notification') {
    send({
      method: 'thread/statusChanged',
      params: { threadId: params?.threadId ?? 'thread-1', status: 'busy' },
      emittedAtMs: Date.now(),
    })
    send({ id, result: { ok: true } })
    return
  }

  if (method === 'trigger/serverRequest') {
    const requestId = serverRequestId++
    send({
      id: requestId,
      method: 'item/commandExecution/requestApproval',
      params: { command: params?.command ?? 'echo hi' },
    })
    send({ id, result: { ok: true, serverRequestId: requestId } })
    return
  }

  if (method === 'trigger/error') {
    sendError(id, -32001, 'triggered error')
    return
  }

  if (method === 'trigger/exit') {
    process.exit(0)
  }

  if (method === 'thread/unsubscribe') {
    send({ id, result: { ok: true } })
    return
  }

  // Reply carried back for a server-request the test answered — surfaced as
  // a notification so tests can assert on the round trip content.
  if (id !== undefined && method === undefined && 'result' in frame) {
    send({
      method: 'test/serverRequestReplyObserved',
      params: { id, result: frame.result },
      emittedAtMs: Date.now(),
    })
    return
  }

  send({ id, result: { echoedMethod: method, receivedParams: params } })
})

process.on('SIGTERM', () => {
  process.exit(0)
})
