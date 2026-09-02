// Shared JSON-RPC + omo app-server wire types for OmoAppServerClient.
// The app-server speaks JSON-RPC 2.0-ish framing over stdio: LF-delimited
// JSON objects on stdout, plain-text logs on stderr. Requests carry an id;
// notifications and server-requests do not (server-requests are just
// server-initiated JsonRpcRequest values that expect a reply).

export type JsonRpcRequestId = string | number

export type JsonRpcRequest = {
  id: JsonRpcRequestId
  method: string
  params?: unknown
}

export type JsonRpcResponse =
  | { id: JsonRpcRequestId; result?: unknown }
  | {
      id: JsonRpcRequestId
      error: { code: number; message: string; data?: unknown }
    }

export type JsonRpcNotification = {
  method: string
  params?: unknown
  emittedAtMs?: number
}

// Server-initiated requests (e.g. approval prompts). Structurally identical
// to a client request but sent the other direction on the same stream.
export type JsonRpcServerRequest = JsonRpcRequest

export type ClientState =
  | 'stopped'
  | 'spawning'
  | 'initializing'
  | 'ready'
  | 'failed'
  | 'recovering'

export type ThreadStartParams = {
  cwd: string
  approvalPolicy?: string
  approvalsReviewer?: string
  model?: string
}

export type ThreadResumeParams = {
  threadId: string
  cwd?: string
  approvalPolicy?: string
  approvalsReviewer?: string
}

export type ThreadForkParams = {
  threadId: string
  cwd?: string
  approvalPolicy?: string
  approvalsReviewer?: string
}

export type TurnStartParams = {
  threadId: string
  input: readonly { type: 'text'; text: string }[]
  clientUserMessageId?: string
}

export type TurnInterruptParams = {
  threadId: string
  turnId: string
}

export type ThreadRecord = {
  id: string
  sessionId: string
  cwd: string
  status: { type: string }
}

export type ApprovalServerRequest = {
  id: JsonRpcRequestId
  method: string
  params: unknown
}
