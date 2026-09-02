# omo app-server Audit

**omo** ships the Codex app-server protocol as `omo app-server`, a Codex-compatible JSON-RPC server for app and editor integrations. It is implemented as a Senpi app-server mode, with `omo` being a re-branded fork of `@code-yeongyu/senpi`.

Source of truth:
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/docs/app-server.md`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/docs/app-server-daemon.md`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/index.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/runtime.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/cli-args.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/transports/stdio.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/transports/websocket.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/threads/registry.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/threads/turn-log.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/server/notifications.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/protocol/methods.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/rpc/registry.js`
- `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/turn-adapter.js`

---

## 1. What omo app-server Is

omo app-server is a Codex-compatible JSON-RPC server that exposes Senpi agent sessions over a wire protocol. It speaks JSON-RPC-shaped messages without a `jsonrpc` field — a request has `id`, `method`, and optional `params`; a success response has `id` and `result`; an error response has `id` and `error`.

> **Doc**: *"App Server mode exposes Senpi as a Codex-compatible JSON-RPC server for app and editor integrations."*
> — `app-server.md` line 1

> **Doc**: *"Protocol Provenance: The raw TypeScript fixture is pinned to Codex git `0fb559f0f6e231a88ac02ea002d3ecd248e2b515` (author date 2026-07-18) [...] `src/modes/app-server/protocol/generated/` is evidence only: it remains byte-identical to Codex except for the local `package.json` compilation shim."*
> — `app-server.md` lines 25–32

The server ships as a mode within the Senpi distribution. `omo app-server` is the command; the implementation lives in `dist/modes/app-server/`.

> **Code**: `runAppServerMode` in `index.js` lines 11–66 — selects transport, wires core, handles shutdown.
> **Code**: `createAppServerRuntime` in `runtime.js` lines 13–93 — assembles ThreadRegistry, TurnLog, ApprovalBridge, NotificationRouter, FuzzyFileSearch, and the method registry.

---

## 2. Transports and Authentication

### Transport Types

| URL form | Kind | Notes |
|---|---|---|
| `stdio://` | stdio | Default when `--listen` omitted. One process-owned connection. Framed as one JSON object + LF per message. stdout is protocol; logs go to stderr. |
| `ws://IP:PORT` | WebSocket | Binds only to IP-literal hosts. HTTP `Origin` rejected. `/readyz` and `/healthz` return `ok\n`. |
| `unix://` | Unix-domain socket | Default socket path: `${SENPI_CODING_AGENT_DIR}/app-server/app-server.sock` |
| `unix:///abs/path` | Unix-domain socket | Explicit absolute path. |

> **Doc**: *"The websocket listener binds only to IP literal hosts."*
> — `app-server.md` line 6

> **Code**: `parseListen` in `cli-args.js` lines 11–49 — validates each URL form. stdio is default (line 69).

### WebSocket Ports

| Daemon | Default port | Transport |
|---|---|---|
| Direct `--listen ws://` | `18990` | WebSocket |
| `daemon start` | `18800` | WebSocket |

> **Doc**: *"senpi app-server --listen ws://127.0.0.1:18990"* — primary WebSocket recipe.
> **Doc**: *"The daemon default listener is `ws://127.0.0.1:18800`."* — `app-server-daemon.md` line 11.

### Authentication

- **Bearer token** for WebSocket. When `--ws-auth` is omitted, Senpi creates or reuses a token at `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token` and prints the path to stderr.
- **`--ws-auth off`** disables bearer auth for loopback hosts only.
- **`--ws-auth <path>`** reads from an explicit token file.
- **`stdio://`** has no auth — trusted local subprocess only.

> **Doc**: *"When `--ws-auth` is omitted, Senpi creates or reuses a bearer token file at `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token`, prints that path to stderr, and requires `Authorization: Bearer <token>` on websocket upgrades."*
> — `app-server.md` lines 14–18

> **Code**: `toWebSocketAuth` in `index.js` lines 94–107 — converts CLI options to `{kind:"off"|"token-file"}` or `undefined`.

---

## 3. Supported Request Methods Table

### Stable Methods

| Method | Support and Senpi behavior |
|---|---|
| `initialize` | **Required once per connection** before all other requests. Sets `connection.initialized`. Returns `userAgent`, `codexHome`, `platformFamily`, `platformOs`. Requests before init get `-32000 Not initialized`; second init gets `-32000 Already initialized`. |
| `model/list` | Configured models only. Supports `includeHidden`, numeric cursors. Model records include Codex-compatible `reasoning-effort`, `service-tier`, `isDefault` fields. |
| `config/read` | Mapped settings subset: `model`, `model_provider`, `model_reasoning_effort`. Fixed Senpi posture: `approval_policy` always `"never"`, `sandbox_mode` always `"danger-full-access"`. Uses `cwd` to resolve project settings. |
| `configRequirements/read` | Returns `{"requirements":null}` — Senpi has no Codex requirements source. |
| `account/read` | Honest local credential state: `{account:{type:"apiKey"}}` only when a provider credential exists, else `{account:null}`; `requiresOpenaiAuth:false`. |
| `account/rateLimits/read` | Returns invalid-request error — rate limits require a Codex account. |
| `account/usage/read` | Returns invalid-request error — usage requires a Codex account. |
| `skills/list` | Resource-loader skills and diagnostics per requested working directory. |
| `mcpServerStatus/list` | Per-loaded-session MCP status; `full` and `toolsAndAuthOnly` detail views with numeric pagination. |
| `permissionProfile/list` | Senpi's actual single `dangerFullAccess`-equivalent profile. |
| `experimentalFeature/list` | Numeric-cursor paginated Senpi feature catalog; may be empty. |
| `fuzzyFileSearch` | One-shot subsequence file search over requested roots; empty query returns no results. |
| `thread/start` | Creates, loads, and subscribes the calling connection to a session-backed thread. Also emits `thread/started` notification (possibly before response). |
| `thread/resume` | Loads a saved thread from disk and subscribes the calling connection. |
| `thread/read` | Reads a thread, optionally including turns (`includeTurns: true`). |
| `thread/list` | Lists saved and loaded threads with forward `nextCursor` and backward `backwardsCursor`. |
| `thread/loaded/list` | Lists IDs of threads loaded in this app-server process (in-memory only). |
| `thread/fork` | Creates and loads a session-backed fork of a thread. |
| `thread/name/set` | Sets display name; broadcasts `thread/name/updated` to thread subscribers. |
| `thread/archive` | Archives and unloads a thread. |
| `thread/unarchive` | Storage-only restore: returns `status:{type:"notLoaded"}` then broadcasts `thread/unarchived`. Does not resume. |
| `thread/delete` | Deletes thread and its app-server sidecars from disk. |
| `thread/unsubscribe` | Detaches the current connection; thread may idle-unload later. |
| `thread/compact/start` | Acknowledges immediately and compacts the loaded thread. Does not emit `thread/compacted`. |
| `thread/goal/set` | Persists a goal; broadcasts `thread/goal/updated` after response. Accepts `active`, `paused`, `complete`. |
| `thread/goal/get` | Reads persisted thread goal or `null`. |
| `thread/goal/clear` | Clears goal; broadcasts `thread/goal/cleared` only when a goal existed. |
| `thread/metadata/update` | Persists `gitInfo` in app-server sidecar; returns updated wire thread. |
| `turn/start` | Starts a turn on a loaded thread. Requires thread to be loaded. |
| `turn/steer` | Queues input for an active turn. Returns error if no active turn. |
| `turn/interrupt` | Interrupts an active turn. No-op if already finished. |

> **Doc**: Full stable methods table — `app-server.md` lines 411–428.

### Experimental Methods (require `capabilities.experimentalApi: true`)

| Method | Senpi behavior |
|---|---|
| `remoteControl/status/read` | Returns truthful disabled status, stable local installation ID, `environmentId:null`. |
| `remoteControl/client/list` | Returns honest internal error (no remote-control handle). |
| `collaborationMode/list` | Returns Senpi's one fixed collaboration preset. |
| `thread/search` | Searches session text; default source filter excludes `appServer`; pass `sourceKinds:["appServer"]`. |
| `thread/searchOccurrences` | Finds literal UTF-16 ranges in thread's user/final-agent messages. |
| `thread/turns/list` | Paginated turn history. Turn logs survive idle unload in same process. Process restart loses in-memory log; falls back to user-message-only reconstruction. |
| `thread/items/list` | Paginated items; same post-restart limitation as `thread/turns/list`. |
| `thread/settings/update` | **Partial**: supports only session-scoped `model` and `effort`. Other fields fail with invalid-request error. |
| `fuzzyFileSearch/sessionStart` | Starts a fuzzy-search session over requested roots. |
| `fuzzyFileSearch/sessionUpdate` | Updates query; emits `fuzzyFileSearch/sessionUpdated` then `fuzzyFileSearch/sessionCompleted`. |
| `fuzzyFileSearch/sessionStop` | Stops an existing fuzzy-search session. |

> **Doc**: Full experimental methods table — `app-server.md` lines 434–445.

### Intentionally Unsupported (`-32601` after init)

Senpi returns `-32601 Method not found` for these rather than a partial or invented implementation. This is an explicit compatibility boundary.

Key areas: Codex account flows, configuration writes, direct filesystem/command APIs, MCP marketplace ops, remote-control enrollment, Windows-only ops, environments/processes/memory/realtime.

> **Doc**: Full `-32601` table — `app-server.md` lines 511–523.

---

## 4. Routing and Lifecycle

### Thread = Session

A **thread** is a **session**. They are backed by a JSONL file on disk, keyed by `thread.id == sessionId`.

> **Doc**: *"Each app-server process can keep multiple loaded threads."*
> — `app-server.md` line 495

> **Code**: `ThreadRegistry` in `registry.js` lines 14–195 — `createThread` calls `createAgentSession`, maps `session.sessionId` to `thread.id`, stores the session file under `sessions/` in the agent directory.

> **Code**: `registerSession` in `registry.js` — sets `entry.session.sessionFile` to the JSONL path; `path` field in wire thread = `sessionFile ?? null`.

### Session Persistence Path

Sessions are stored as JSONL under `${SENPI_CODING_AGENT_DIR}/sessions/`. The filename pattern is `{ISO timestamp}_{threadId}.jsonl`.

> **Code**: `ENV_SESSION_DIR` / `getAgentDir()` in `runtime.js` lines 1, 27, 47 — agent dir from config (`~/.omo/agent` for omo).

> **Live frame**: `"path":"/home/whrho/.omo/agent/sessions/--tmp--/2026-09-01T17-16-55-188Z_01a05df9-5014-78b2-99f3-9fc132859761.jsonl"`

### TurnLog — In-Memory Turn History

`TurnLog` is an in-memory ring of turn records per thread. It records `turnId`, `startedAt`, `completedAt`, `durationMs`, `error`, `status`, and `items`.

> **Code**: `TurnLog` class in `turn-log.js` lines 1–73 — `turnsByThreadId: Map<threadId, TurnRecord[]>`. Persists across idle unload/resume within the same process.

> **Doc**: *"The app-server `TurnLog` is retained for the lifetime of the process. Idle unload disposes the session but does not release its turn log, so unloading and then resuming a thread in the same process preserves full `thread/turns/list` and `thread/items/list` history. A process restart loses that in-memory log."*
> — `app-server.md` lines 500–503

### Idle Unload

When a thread has no subscribers and no active turn, it is unloaded after **30 minutes** of idle time.

> **Code**: `lifecycle = registerThreadLifecycleHandlers(..., { idleUnloadMinutes: 30, ... })` in `runtime.js` line 83.

> **Code**: `scheduleIdleUnloadForThread` in `server-core.js` — callback set at `runtime.js` line 53: `(threadId) => lifecycle?.scheduleIdleUnloadForThread(threadId)`.

> **Code**: `setTimeout(() => this.unloadIfIdle(entry.id), this.idleUnloadMs)` in `handlers.js` line 377 — 30-minute timer per thread entry.

### Notifications

Server-to-client events use the Codex envelope with `method`, optional `params`, and `emittedAtMs`. There is no `id` on notifications.

- **Broadcast** (all connections): thread lifecycle updates, goal mutations, fuzzy-search sessions.
- **Thread-scoped** (thread subscribers only): turn lifecycle, item events, `thread/settings/updated`, `turn/diff/updated`.
- Terminal `turn/completed` and `error` are queued briefly when no subscriber is attached (capped at 100 per thread).

> **Code**: `NotificationRouter` in `notifications.js` lines 23–118 — `broadcast()` and `toThread(threadId, notification)`.

---

## 5. Live Probe — Captured JSON-RPC Frames

**Date**: 2026-09-01
**omo version**: `2026.8.31`
**Platform**: `Linux 5.14.0; x64`
**node**: v24.14.0
**Command**: `omo app-server --listen stdio://`

### Probe Script

```bash
printf '%s\n' \
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"omo-probe","title":"probe","version":"0.0.1"},"capabilities":{"experimentalApi":true}}}' \
  '{"id":2,"method":"thread/start","params":{"cwd":"/tmp"}}' \
  '{"id":3,"method":"thread/list","params":{"limit":2}}' \
  | timeout 8 omo app-server --listen stdio://
```

### Captured stdout (verbatim, one JSON object + LF per line)

```
{"id":1,"result":{"userAgent":"omo-probe/2026.8.31 (Linux 5.14.0-687.26.1.el9_8.x86_64; x64) senpi_app_server","codexHome":"/home/whrho/.omo/agent","platformFamily":"unix","platformOs":"linux"}}
{"method":"extension_event","params":{"type":"extension_event","name":"terminal_monitor_state","data":{"activeCount":0,"monitors":[]},"threadId":"01a05df9-5014-78b2-99f3-9fc132859761"},"emittedAtMs":1788283015435}
{"id":2,"result":{"thread":{"id":"01a05df9-5014-78b2-99f3-9fc132859761","sessionId":"01a05df9-5014-78b2-99f3-9fc132859761","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"local-proxy","createdAt":1788283015.435,"updatedAt":1788283015.435,"recencyAt":1788283015.435,"status":{"type":"idle"},"path":"/home/whrho/.omo/agent/sessions/--tmp--/2026-09-01T17-16-55-188Z_01a05df9-5014-78b2-99f3-9fc132859761.jsonl","cwd":"/tmp","cliVersion":"2026.8.31","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"gpt-5.6-sol","modelProvider":"local-proxy","serviceTier":null,"cwd":"/tmp","runtimeWorkspaceRoots":["/tmp"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":"medium","multiAgentMode":"explicitRequestOnly"}}
{"method":"thread/started","params":{"thread":{"id":"01a05df9-5014-78b2-99f3-9fc132859761","sessionId":"01a05df9-5014-78b2-99f3-9fc132859761","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"local-proxy","createdAt":1788283015.435,"updatedAt":1788283015.435,"recencyAt":1788283015.435,"status":{"type":"idle"},"path":"/home/whrho/.omo/agent/sessions/--tmp--/2026-09-01T17-16-55-188Z_01a05df9-5014-78b2-99f3-9fc132859761.jsonl","cwd":"/tmp","cliVersion":"2026.8.31","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}},"emittedAtMs":1788283015435}
{"id":3,"result":{"data":[{THREAD_ENTRIES...}],"nextCursor":"Mg==","backwardsCursor":null}}
```

### Captured stderr (verbatim)

```
senpi app-server listening on stdio://
MCP initialization failed: Theme not initialized. Call initTheme() first.
app-server stdio closed: stdin ended
```

### Frame Analysis

| Frame | Direction | Type | Key values |
|---|---|---|---|
| Request 1 | client→server | request | `id:1`, `method:"initialize"`, `experimentalApi:true` |
| Response 1 | server→client | success | `id:1`, `userAgent:"omo-probe/2026.8.31..."`, `codexHome:"/home/whrho/.omo/agent"`, `platformOs:"linux"` |
| Notification 1 | server→client | broadcast | `method:"extension_event"`, `terminal_monitor_state`, `threadId:"01a05df9-..."` |
| Request 2 | client→server | request | `id:2`, `method:"thread/start"`, `cwd:"/tmp"` |
| Response 2 | server→client | success | `id:2`, `thread.id==sessionId:"01a05df9-..."`, `model:"gpt-5.6-sol"`, `reasoningEffort:"medium"`, `sandbox:"dangerFullAccess"`, session file path under `sessions/--tmp--/` |
| Notification 2 | server→client | thread-scoped | `method:"thread/started"`, same thread object, `emittedAtMs` |
| Request 3 | client→server | request | `id:3`, `method:"thread/list"`, `limit:2` |
| Response 3 | server→client | success | `id:3`, `data` array with 2 threads (one notLoaded, one idle), `nextCursor:"Mg=="`, `backwardsCursor:null` |

**Notable live observations**:
- `thread.start` resolves to model `gpt-5.6-sol` on `local-proxy` provider — the configured omo model.
- `reasoningEffort` is `medium` (not `null` as in the doc examples, which used an unconfigured isolated checker).
- `cliVersion` is `2026.8.31` (omo-specific).
- `thread/list` returned a `notLoaded` thread from a prior session alongside the newly created `idle` thread.
- `path` in the wire thread uses `sessions/--tmp--/` as a session-keyed subdirectory (cwd-derived slug).

---

## 6. Codex Primitive → omo Session Mapping Hints

| Codex concept | omo mapping |
|---|---|
| `thread.id` | `sessionId` — they are always equal. `ThreadRegistry.registerSession` sets `entry.id = session.sessionId`. |
| `thread.path` | `sessionFile` on the underlying session object. Serialized as `"path"` in the wire thread. Format: `{agentDir}/sessions/{slug}/{timestamp}_{threadId}.jsonl`. |
| `thread.source` | `"appServer"` when created via app-server; other values for CLI sessions. Set by `createAgentSession` with `source` param. |
| `thread.status` | `"idle"` = thread loaded, no active turn. `"running"` = active turn. `"notLoaded"` = persisted but not in memory. |
| `thread.turns` | `TurnLog` in-memory records; persisted as JSONL lines. `thread/turns/list` reads TurnLog (same-process) or reconstructs from JSONL (cross-process). |
| `thread/items` | Tool-call results, messages, diffs — written as JSONL lines to the session file. `thread/items/list` reads from TurnLog items (in-process) or reconstructs from JSONL. |
| `thread.forkedFromId` | Set by `SessionManager.forkFrom` when forking. |
| `thread/loaded/list` | Returns `thread.id` values from `ThreadRegistry.entries.keys()` — threads currently in memory. |
| `thread/start` | `ThreadRegistry.createThread` → `createAgentSession` → `registerSession`. Also subscribes the current connection. |
| `thread/resume` | `ThreadRegistry.resumeThread` → reads JSONL from `sessionFile` → `createAgentSession` → `registerSession`. |
| `thread/archive` | Calls `ThreadRegistry.unloadThread` — disposes session but keeps JSONL on disk. |
| `thread/delete` | Calls `ThreadRegistry.deleteThread` — `session.dispose()`, deletes JSONL, removes from `entries`. |
| `turn/start` | `createTurnEngine.startTurn` → appends turn record to `TurnLog`, starts model execution. Emits `turn/started`, then streaming items via `item/*` notifications, finally `turn/completed`. |
| `turn/interrupt` | `createTurnEngine.interruptTurn` → sets interrupt flag on active turn. |
| `approvalPolicy` | Always `"never"` — Senpi's permission posture has no `ask` mode via app-server. `sandbox.type` is always `"dangerFullAccess"`. |
| `reasoningEffort` | Maps to Senpi's thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Default `null` means use model/system default. |
| `cwd` | Passed to `thread/start`, `thread/resume`, `thread/fork`. Used to resolve project settings and as `runtimeWorkspaceRoots` in the response. |
| `model` | The default model ID from `SettingsManager`. Used to create the agent session. |
| `codexHome` | `getAgentDir()` → `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}` (for omo: `~/.omo/agent`). Session files live under `{codexHome}/sessions/`. |
| Subscribers | `NotificationRouter.toThread` fans out to all connections registered as subscribers of a given `threadId`. `thread/unsubscribe` removes one connection. |

---

## Quick Reference: Error Codes

| Code | Meaning |
|---|---|
| `-32000` | Not initialized (no `initialize` sent yet) |
| `-32000` | Already initialized (second `initialize`) |
| `-32600` | Invalid request (missing thread, no active turn, experimental capability required) |
| `-32601` | Method not found (intentional unsupported surface after init) |
| `-32603` | Internal error |

---

*Audit produced from source at `/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/` and live probe on omo `2026.8.31` / Linux x64.*
