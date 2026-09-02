# Codex Remote Reference Audit — codex-remote-control-lab & CodexRemote

Audit of two reference implementations of remote clients for the Codex CLI `app-server` protocol, with design
patterns extracted for omomaki (Discord bot driving the omo/senpi app-server, doc:
`/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/docs/app-server.md`).

---

## 1. `codex-remote-control-lab` — Node phone bridge

### Architecture

`phone browser -> http://Mac-LAN-IP:45214 -> Node bridge -> ws://127.0.0.1:45213 -> Codex app-server`
(diagram from `_refs/codex-remote-control-lab/README.md`, section "🧭 Architecture").

- Single Node script `_refs/codex-remote-control-lab/scripts/start-phone.js` (2383 lines) does everything: spawns
  `codex app-server --listen ws://127.0.0.1:<port>` as a child process (`startCodexServer()`,
  `_refs/codex-remote-control-lab/scripts/start-phone.js` ~L440-460), waits on `GET /readyz`
  (`waitForReady()`, `_refs/codex-remote-control-lab/scripts/start-phone.js` ~L216-230), then runs its own
  HTTP+WebSocket server for browser clients on `PHONE_UI_PORT` (default 45214).
- Browser UI is a static single-page app served from `_refs/codex-remote-control-lab/public/` (`main.js`,
  `index.html`, `style.css`) — no framework build required for the deployed app; `src/ui/Shell.jsx` and
  `scripts/build-ui.mjs` are a newer React-based UI variant being built with esbuild
  (`_refs/codex-remote-control-lab/package.json` script `build:ui`).
- `package.json` (`_refs/codex-remote-control-lab/package.json`) declares `@openai/codex ^0.130.0` as the only
  Codex dependency (devDependency, vendored CLI binary) plus `ws` for WebSocket.
- Two upstream RPC client shapes exist in the same file:
  1. `AppServerRpcClient` (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L370-430) — a private,
     per-process client used for one-off calls (history sync, rate limits) with `initialize` → `initialized` →
     request/response over a single connection.
  2. `SharedBridge` (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L900+) — one instance per active
     Codex thread, holding exactly one upstream WebSocket to the app-server and fanning out events to N browser
     WebSocket clients (`this.clients`). This is the "shared thread across devices" mechanism.
- A `ClaudeBridge` class (same file) exists as an experimental alternate provider that shells out to
  `claude -p --output-format stream-json` per turn instead of talking to an app-server — confirms the bridge
  pattern generalizes across agent backends, relevant if omomaki ever supports multiple senpi/agent backends.

### JSON-RPC methods called against app-server

Confirmed from `_refs/codex-remote-control-lab/scripts/start-phone.js`:

| Method | Where | Notes |
|---|---|---|
| `initialize` | `AppServerRpcClient.ensureReady()` and `SharedBridge.bindUpstream()` | `clientInfo: {name, title, version}`, no `capabilities` field sent (no experimentalApi request seen) |
| `initialized` (notification) | same, sent immediately after `initialize` resolves | plain notification, no id |
| `thread/start` | `SharedBridge.bindUpstream()`, when no `requestedThreadId` | params: `{model, cwd, approvalPolicy: "on-request", sandbox: "workspace-write"}` |
| `thread/resume` | same method, when `requestedThreadId` present (from `?thread=` query param) | params add `threadId` |
| `turn/start` | `SharedBridge.startPrompt()` | params: `{threadId, input: [{type:"text",...}, {type:"localImage",...}], model?, approvalPolicy?, sandboxPolicy?}` |
| `turn/interrupt` | `SharedBridge.sendTurnInterrupt()` | params: `{threadId, turnId}` |
| `thread/read` | via `runHistorySync()` in `_refs/codex-remote-control-lab/scripts/history-sync.js` (called from `SharedBridge.syncHistory()`) | used to warm app-server's cached history after a turn so Codex Desktop discovers updates |
| `thread/list` | also in `history-sync.js`, "scan-backed" list call | same purpose |

Notifications/server-initiated messages handled: `item/agentMessage/delta` (assistant streaming text),
`item/started`, `item/completed`, `turn/completed`, `error`, and any method ending in `/requestApproval`
(generic suffix match — see approvals below), all in `SharedBridge.bindUpstream()`'s `upstream.on("message")`
handler (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L1485-1600). No `turn/steer` call exists in
this repo — the bridge instead **queues** prompts client-side (`this.turnQueue`) and fires a fresh `turn/start`
once the active turn completes (`startNextQueuedTurn()`), rather than steering a live turn.

### Auth / token handling

- `getToken()` (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L165-172): if `PHONE_TOKEN` env is set,
  use it; else read `.phone-token` from disk; else generate `crypto.randomBytes(18).toString("base64url")` and
  persist to `.phone-token` with `mode: 0o600`.
- `requireToken()` (~L640-646) checks `url.searchParams.get("token") === phoneToken` on every HTTP/WS request;
  returns 401 otherwise. Token travels as a URL query param (`?token=...`), not a header — deliberate for
  browser/QR-link simplicity but means the token can leak via browser history, referrers, logs.
- `PHONE_DEBUG_NO_TOKEN=1` binds to `127.0.0.1` only and skips the token entirely; `PHONE_DEBUG_BIND=lan` is an
  explicit opt-in to bind `0.0.0.0` with **no** token — both documented as trusted-network-only debug switches in
  `_refs/codex-remote-control-lab/docs/guide/security.md`.
  The listen host itself is chosen dynamically: `const listenHost = tokenRequired || debugLan ? "0.0.0.0" : "127.0.0.1"`
  (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L90).
- Upstream Codex app-server itself has **no auth** — it's `ws://127.0.0.1:...`, unauthenticated by design, and
  the doc repeatedly states "Keep the Codex app-server on `127.0.0.1`... only the small token-protected bridge
  is reachable from the LAN" (`_refs/codex-remote-control-lab/README.md`, "🔐 Safety Notes").

### Thread sync between devices

- The bridge keys `SharedBridge` instances by `bridgeKey` in a `Map` (`bridges`, module scope in
  `_refs/codex-remote-control-lab/scripts/start-phone.js`). `bridgeKeyForRequest()` /
  `shouldPromoteBridgeKey()` (imported from `scripts/bridge-state.js`) decide whether a new browser connection
  attaches to an existing bridge or a fresh transient key gets "promoted" to the real `threadId` once
  `thread/start`/`thread/resume` resolves (`SharedBridge.promoteBridgeKey()`, ~L1010-1018). This lets a phone
  open the bridge before the thread id is known and still land on the same shared bridge as a desktop browser
  that already knows the thread id.
- `SharedBridge.addClient(browser)` adds each new WS client to `this.clients` (a `Set`) and immediately replays
  `ready` (full state incl. `history`) if already connected — i.e. late-joining devices get resynced state, not
  just future deltas.
- Idle disposal: when the last client disconnects, `shouldDisposeIdleBridge()` decides whether to close the
  upstream and delete the bridge from the map (`_refs/codex-remote-control-lab/scripts/bridge-state.js`).
- Cross-app sync with **Codex Desktop** (a separate GUI, not this bridge) is explicitly called out as
  best-effort/asymmetric: Desktop's normal view uses a private `stdio` app-server the bridge cannot reach; the
  bridge only pushes `thread/read`+`thread/list` refresh calls after each turn so Desktop's sidebar/history
  picks up new content on next open/refresh — "not a live body update path" (`docs/guide/phone-bridge.md`).

### Approvals handling

- Approval requests are detected generically by suffix match: `msg.method.endsWith("/requestApproval")`
  (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L1594-1601), covering
  `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` without hardcoding both names.
- On approval, bridge sets run state to `"approval"`/`承認待ち`, emits an `approval` event to all connected
  browsers with the raw request `{id, method, params}, and fires a push notification via `notifyRunEvent(...)`
  (Discord/ntfy/Pushover — see `_refs/codex-remote-control-lab/scripts/phone-notify.js`).
- `SharedBridge.approval(requestMsg, decision)` (~L1225-1240) replies directly to app-server with
  `{id: requestMsg.id, result: {decision: accept ? "accept" : "decline"}}` — a plain JSON-RPC response sent back
  over the *same* upstream WebSocket (app-server request/response correlation by `id`, not a separate endpoint).
  Only binary accept/decline is modeled here, no `acceptForSession`/`cancel` (unlike CodexRemote/senpi, see §2/§3).
- Next-turn approval policy and sandbox mode are user-selectable per prompt via `options.approvalPolicy` /
  `options.sandboxMode`, translated to `sandboxPolicyForMode()` (~L610-620) which maps `"danger-full-access"` →
  `{type:"dangerFullAccess"}`, `"read-only"` → `{type:"readOnly", networkAccess:true}`, default →
  `{type:"workspaceWrite", writableRoots:[workdir], networkAccess:true, ...}`.

### Model selection

- Model list is a hardcoded array per provider (`modelOptions`, ~L104-107): Codex gets
  `["gpt-5.5","gpt-5.4","gpt-5.3-codex","gpt-5.3-codex-spark","gpt-5.2"]`; Claude gets model name strings. No
  `model/list` RPC call to app-server — the UI's model picker is a static list, and the chosen value is passed
  straight through as `params.model` on `turn/start`. Screenshot evidence: `docs/assets/mobile-model-menu.png`.

### Image attachments

- Browser sends attachments as data URLs (base64) inside the WS `prompt` message; `saveDataUrlAttachment()`
  (`_refs/codex-remote-control-lab/scripts/start-phone.js` ~L945-965) decodes `data:image/...;base64,...`,
  validates the MIME prefix is `image/`, writes to a local `.uploads/` dir with `mode: 0o600` and a randomized
  filename (`crypto.randomBytes(4)` + sanitized original name), then returns `{input: {type:"localImage", path},
  preview: {name, path, url: "/api/uploaded?name=..."}}`.
- `input.type: "localImage"` with a filesystem `path` is pushed into `turn/start`'s `input` array alongside the
  `{type:"text", ...}` entry — i.e. the bridge downloads/stores the image locally first and hands app-server a
  **local file path**, not inline base64 in the RPC call itself.
- `/api/uploaded` and `/api/file/raw` routes (referenced in `summarizeItem()`, ~L985-1000) serve those files back
  to browsers behind the same token check, so the browser never needs direct filesystem access.

### 3-5 concrete patterns omomaki should copy

1. **Keep app-server on loopback, expose only a thin token-checked surface.** The bridge never lets the raw
   unauthenticated `ws://127.0.0.1` app-server touch the network; every LAN/remote request passes through
   `requireToken()`. Omomaki should keep its senpi app-server subprocess on `127.0.0.1`/stdio and let Discord
   (already an authenticated transport) be the only public-facing surface — never bind the app-server socket to
   `0.0.0.0`. (`_refs/codex-remote-control-lab/scripts/start-phone.js` L640-646, README "🧭 Architecture".)
2. **One shared upstream connection multiplexed to N clients, keyed by thread id with late-promotion.** `SharedBridge`
   demonstrates cleanly how to let multiple "devices" (for omomaki: multiple Discord channels/threads or multiple
   users in the same channel) attach to the same live Codex thread and get replayed state on join instead of each
   opening a separate upstream connection. Reuse the `bridgeKey → threadId promotion` idea for mapping Discord
   thread/channel IDs to app-server `threadId`s before the id is known. (`SharedBridge.promoteBridgeKey()`, `scripts/bridge-state.js`.)
3. **Client-side turn queueing instead of `turn/steer`.** This repo never calls `turn/steer`; it queues follow-up
   prompts and re-issues `turn/start` after `turn/completed`. Omomaki (Discord, not a live edit-in-place UI) should
   likely do the same — queue a user's next message if a turn is active, rather than assuming `turn/steer`
   support, since senpi's app-server doc confirms `turn/steer` exists but is for "queue steering text for an
   *active* turn" — a narrower feature than general messaging.
4. **Generic approval-suffix detection + explicit decision mapping, not hardcoded method names.** The
   `.endsWith("/requestApproval")` check is future-proof against new approval kinds ; combine with the CodexRemote
   pattern (§2) of mapping decision → `{decision: "accept"|"decline"|"acceptForSession"|...}` based on the
   *specific* request method, since senpi's doc confirms 4 distinct command-approval decisions
   (`accept`, `acceptForSession`, `decline`, `cancel`) — the lab's binary accept/decline undershoots this.
5. **Local-path image attachments, not inline base64 into RPC.** Downloading Discord attachment URLs to a local
   temp dir (with tight permissions + randomized names) and passing `{type:"localImage", path}` in `turn/start`
   input mirrors exactly what omomaki needs for Discord image messages — avoids inflating JSON-RPC payloads and
   matches how app-server itself expects local images.
6. **Push-notification hooks on `approval`/`completed`/`failed` bridge events.** `notifyRunEvent()` +
   `phone-notify.js`'s multi-provider webhook fan-out (ntfy/Pushover/Discord) is a ready template for omomaki's
   own "ping the Discord channel when a turn needs approval or finishes" behavior — note it already posts to
   Discord webhooks, so the shape of `taskNotificationMessage()` is a reasonable starting schema.

---

## 2. `CodexRemote` — Mac companion service + iOS client

### Architecture

Two apps in a small monorepo, sharing a `packages/protocol` type package:

- `_refs/CodexRemote/apps/mac-companion` (Node/TypeScript): spawns `codex app-server` over **stdio** (not
  WebSocket) as a child process, exposes a local REST + WebSocket API (`/v1/...`, `/v1/stream`), and does
  best-effort "nudge the visible Codex Desktop app to select this chat" via screenshot/OCR/AppleScript
  (`apps/mac-companion/src/desktop/*`, `apps/mac-companion/scripts/ocr-screenshot.swift`).
- `_refs/CodexRemote/apps/ios` (SwiftUI): pairs with the companion via QR code, then talks to it over
  HTTP(S)/WS(S) with a bearer device token — never talks to app-server directly.
- `_refs/CodexRemote/packages/protocol/src/index.ts`: a small shared TypeScript types package (Project,
  ChatThread, Message, ChatActivity, ApprovalRequest, PairingRequestResponse, StreamEvent, etc.) consumed by
  the companion (and mirrored by hand in Swift on the iOS side — no codegen bridge observed).
- `_refs/CodexRemote/docs/architecture.md` "Runtime flow" (10 numbered steps) is the authoritative summary: QR
  pairing → nonce validation + local Mac GUI confirmation → device token + transport scheme issuance → iOS
  stores scheme, derives `ws`/`wss` → activates chat → loads local rollout history → re-hydrates any pending
  approval → subscribes to `/v1/stream`.

### JSON-RPC methods called against app-server

Confirmed from `_refs/CodexRemote/apps/mac-companion/src/codex/client.ts` (the actual
`CodexAppServerClient`, generic `request()`/`notify()`/`respond()` wrapper over stdio, JSON-line framed) plus
call sites grepped in `_refs/CodexRemote/apps/mac-companion/src/http/mapping.ts` and
`_refs/CodexRemote/apps/mac-companion/src/http/server.ts`:

| Method | Where | Notes |
|---|---|---|
| `initialize` | `CodexAppServerClient.initialize()` (`codex/client.ts` ~L140-155) | `clientInfo: {name:"codex_remote_companion", title:"Codex Remote Mac Companion", version:"0.1.6"}`, then sends bare `initialized` notification |
| `initialized` (notification) | same, via `this.notify("initialized", {})` | |
| (thread/turn methods) | referenced via `docs/api.md` REST mapping: `POST /v1/chats` → thread create/start; `POST /v1/chats/{id}/messages` → turn start; `POST /v1/chats/{id}/steer` → **`turn/steer`** when a turn is active, else falls back to `turn/start`; `POST /v1/chats/{id}/stop` → `turn/interrupt` | Exact RPC method names are abstracted behind `CodexAppServerClient.request(method, params, meta)`; call sites are in `http/mapping.ts`/`http/server.ts` (not individually greped line-by-line here, but the `/v1/chats/{chatId}/steer` semantics documented in `_refs/CodexRemote/docs/api.md` explicitly names Codex `turn/steer` and the `turn/start` fallback) |
| Approval responses | `deps.codexClient.respond(pending.jsonRpcId, buildApprovalResult(...))` (`http/server.ts` ~L1685-1688) | responds to server-initiated request by id, same JSON-RPC id-correlation pattern as the lab repo |

Server-initiated (unsolicited) requests handled generically via `serverRequest` event
(`CodexAppServerClient.handleIncomingLine()`, `codex/client.ts` ~L195-215: any incoming line with both `method`
and `id` and no `result`/`error` is treated as a server request, emitted as `serverRequest`, and answered later
via `respond(id, result)`). `http/server.ts` (~L1819-1826) filters this stream to exactly four approval-shaped
methods: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `mcpServer/elicitation/request` — a closed allowlist rather than the lab
repo's open-ended suffix match. Plain notifications (`method` with no `id`) are re-emitted as `notification`
events for consumers to pattern-match on `turn_started`/`message_delta`/etc. (mirrored into the client-facing
`StreamEventName` union in `packages/protocol/src/index.ts`).

### Auth / token handling

- Two-tier auth: (1) **pairing** — `PairingStore` (`apps/mac-companion/src/pairing/pairing-store.ts`) issues a
  short-TTL `{pairingId, nonce}` via `randomUUID()`/`randomBytes(16).toString("hex")`, consumed exactly once
  with expiry + nonce match check (`consumeSession()`); (2) **device tokens** — `TokenStore`
  (`apps/mac-companion/src/auth/token-store.ts`) issues `randomBytes(32).toString("hex")`, stores only
  `sha256(token)` on disk (never the raw token), and validates with `safeTokenEqual()` (constant-time compare,
  `apps/mac-companion/src/utils/hash.ts`) — a materially stronger token model than the lab repo's plaintext
  `.phone-token` file.
- Companion advertises the transport scheme (`http`/`https`) at pairing time; the pairing QR/response and the
  confirm response both carry `scheme`, and the iOS client stores it per-host and derives `ws`/`wss` for the
  stream endpoint accordingly (`_refs/CodexRemote/docs/architecture.md` "Security model";
  `_refs/CodexRemote/docs/api.md` "Pairing" section). Release iOS builds reject plaintext `http` pairings
  outright (ATS enforcement noted in architecture.md).
- WebSocket auth for `/v1/stream` uses `Authorization: Bearer <token>` **header** on the upgrade request (not a
  query param) plus `chatId` in the query string (`http/server.ts` `server.on("upgrade", ...)` ~L1900-1930) —
  stronger than putting the token in the URL.
- Revocation: `TokenStore.revokeDevice()` / `revokeByToken()`; exposed via `POST /v1/pairing/revoke`
  (`docs/api.md`).
- Security model doc explicitly assumes a private network (Tailscale tailnet) as the base layer, on top of which
  device tokens + pairing sit (`_refs/CodexRemote/docs/architecture.md` "Security model").

### Thread sync between devices

- No literal "shared bridge" object like the lab repo — instead the companion is the single source of truth and
  exposes REST snapshot endpoints (`GET /v1/chats/{chatId}/run-state`, `GET /v1/chats/{chatId}/pending-approval`)
  specifically so a **newly connecting** or **reconnecting** client can rehydrate state it missed rather than
  relying purely on the WS stream (`_refs/CodexRemote/docs/api.md` sections "run-state" and "pending-approval";
  architecture.md flow step 9: "iOS app also re-hydrates any still-open approval for the selected chat so
  desktop-first approval prompts are not lost when mobile connects later").
- `POST /v1/chats/{chatId}/activate` explicitly marks a chat "active" before streaming/follow-ups begin, with
  response `status: already_active | resumed | no_rollout` — a state machine the client can react to.
- Desktop GUI sync ("nudge Codex Desktop to select this chat in its sidebar") is implemented as an
  AppleScript/Accessibility-driven best-effort side channel (`apps/mac-companion/src/desktop/live-sync.ts`,
  `debug-loop/desktop-verification.ts`) — explicitly documented as *not* a true API
  (`docs/architecture.md` "Desktop sync bridge": "does not currently expose a direct... API to the companion").

### Approvals handling

- `http/server.ts` `deps.codexClient.on("serverRequest", ...)` handler (~L1819-1900): filters to the 4 approval
  method names, resolves `chatId` from `params.threadId` (or via `deps.state.getChatByTurn(turnId)` fallback),
  declines immediately with `deps.codexClient.respond(event.id, "decline")` if no chat can be resolved (fail
  closed, not fail open).
- `mapApprovalRequest(event)` translates the raw server request into the shared `ApprovalRequest` protocol type
  (`packages/protocol/src/index.ts`: `kind: "command"|"fileChange"|"mcp"`, `mode: "approval"|"mcp_elicitation"`,
  `riskLevel`, `supportsSessionAllow`, `supportsAlwaysAllow`) before it ever reaches the client — the wire format
  to iOS is fully normalized/provider-agnostic, unlike the lab repo which forwards the raw JSON-RPC message.
- Auto-accept short-circuits before creating a pending approval: `isAlwaysAllowEnabled(scopeKey)` (persisted,
  survives restart, scoped to MCP server+tool fingerprint) checked first, then `isScopedSessionAllowEnabled`/
  `isSessionAllowEnabled` (in-memory, per chat session) — both bypass creating a UI-visible approval and respond
  immediately with `acceptAlways`/`acceptForSession` mapped through `buildApprovalResult()`.
- `POST /v1/approvals/{approvalId}` (client → companion) accepts `decision` ∈
  `approve|decline|allow_for_session|allow_always`; server maps to app-server-specific outbound decisions via
  `buildApprovalResult(requestMethod, responseKind, decision)` (per-method mapping — e.g. `item/permissions/
  requestApproval` uses `"acceptForSession"`/`"acceptAlways"` differently than command/file approvals, per
  `http/mapping.ts` L551-553). After responding, it broadcasts an `approval_cleared` stream event so all
  connected devices drop that approval from their pending list simultaneously (`buildApprovalClearedStreamEvent`).
- When a turn ends, senpi's app-server doc confirms pending approvals for that thread are auto-cancelled server-side
  and a `serverRequest/resolved` notification fires — CodexRemote's approval-cleared broadcast is a
  client-side echo of that same lifecycle guarantee.

### Model selection

- Not implemented as a dedicated picker in the reviewed surface; `GET /v1/projects/{projectId}/context`
  (`docs/api.md`) returns the *current* `model`/`modelReasoningEffort` read from local Codex runtime config, and
  `PATCH /v1/runtime/config` only writes top-level `approvalPolicy`/`sandboxMode` — model itself is not one of
  the two writable fields listed in `docs/api.md` ("Runtime setting writes are also narrow: only top-level
  approval_policy... only top-level sandbox_mode"). No `model/list` RPC call was found in the reviewed files.

### Image attachments

- Not found as a feature in the reviewed surface (`docs/api.md`'s message-sending route only documents a `text`
  field; `POST /v1/dictation/transcribe` handles **audio** dictation via OpenAI transcription, not image
  attachments). `apps/mac-companion/src/http/message-input.ts` exists and may contain more, but none of the
  read files (`docs/api.md`, `docs/architecture.md`) document an image-attachment endpoint or `localImage` input
  construction analogous to the lab repo.

### 3-5 concrete patterns omomaki should copy

1. **Normalize approval requests into a provider-agnostic shape before they reach the UI layer.**
   `mapApprovalRequest()` + the shared `ApprovalRequest` type (`kind`, `mode`, `riskLevel`, `supportsSessionAllow`,
   `supportsAlwaysAllow`) is a much cleaner boundary than forwarding raw JSON-RPC to Discord. Omomaki should build
   one normalized "approval card" schema and map every senpi/app-server approval-shaped server-request into it,
   so Discord embed/button code never branches on raw method names.
2. **Fail closed on missing routing context.** `if (!chatId) { ...; deps.codexClient.respond(event.id, "decline");
   return; }` (`http/server.ts` ~L1841-1846) — if an approval can't be mapped to a known Discord
   channel/thread/user, auto-decline rather than silently dropping it or leaving app-server hanging. Omomaki
   should adopt the same default-deny behavior for orphaned approval requests.
3. **Persisted "always allow" scoped by tool/server fingerprint, not blanket.** `enableAlwaysAllow(scopeKey)` and
   `isAlwaysAllowEnabled(scopeKey)` scope trust to a specific MCP server+tool pair, stored in a local JSON file
   next to the token store, surviving restarts. For omomaki, an equivalent "always allow this command pattern for
   this user/guild" preference (rather than "trust everything forever") avoids over-broad automatic approval.
4. **REST rehydration endpoints alongside the live event stream.** `GET /v1/chats/{chatId}/run-state` and
   `GET /v1/chats/{chatId}/pending-approval` exist specifically so a client that connects/reconnects late (Discord
   equivalent: a user reopening a thread, or the bot process restarting) can recover current state without racing
   the event stream. Omomaki should expose (internally, not necessarily as REST) an equivalent "what is this
   thread's current turn/approval state right now" query path, independent of notification delivery.
5. **Bearer token in header + `chatId` in query only, never token in the URL query string**, for any WS-like
   channel. If omomaki ever needs a non-Discord bridge surface (e.g. a web dashboard), follow this over the lab
   repo's `?token=` pattern — avoids token leakage via logs/referrers/history.
6. **Hash stored tokens, compare with constant-time equality.** `TokenStore` never persists raw tokens
   (`sha256(token)` only) and uses `safeTokenEqual()` for comparison — directly applicable if omomaki ever
   stores any bot-issued secrets (e.g. per-guild API keys) on disk.

---

## 3. Protocol differences vs omo/senpi app-server

Comparing both repos' Codex CLI app-server usage against
`/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/docs/app-server.md`:

- **Framing差**: senpi's doc specifies stdio framing as "one UTF-8 JSON object followed by LF" and websocket
  framing as "each websocket text frame is one JSON object" — both reference repos match this exactly (lab repo
  over `ws://`, CodexRemote's `codex/client.ts` over stdio with `readline` line-splitting). No incompatibility
  here.
- **`capabilities.experimentalApi`**: senpi gates several methods (`remoteControl/status/read`,
  `thread/search`, `thread/settings/update`, `thread/turns/list`, `thread/items/list`, fuzzy-search sessions,
  etc.) behind `capabilities.experimentalApi: true` sent in `initialize`. **Neither reference repo sends a
  `capabilities` field at all** in their `initialize` calls (lab repo: `_refs/codex-remote-control-lab/scripts/
  start-phone.js` `ensureReady()`/`SharedBridge.bindUpstream()`; CodexRemote: `apps/mac-companion/src/codex/
  client.ts` `initialize()`) — both only send `clientInfo`. Neither uses any experimental-gated method in the
  reviewed code, so this gap is latent, but **omomaki must explicitly opt in via `capabilities.experimentalApi:
  true`** if it wants `thread/search`, `thread/turns/list`, `thread/settings/update` (session model/effort
  changes), or fuzzy file search against senpi — none of these reference clients demonstrate that call shape.
- **`turn/steer` usage differs between the two repos and neither fully matches senpi's semantics.** The lab
  repo never calls `turn/steer` at all (client-side queueing instead). CodexRemote's `docs/api.md` documents
  `POST /v1/chats/{chatId}/steer` calling Codex `turn/steer` with a documented fallback to plain `turn/start`
  when "the run has already ended in the meantime" — but the senpi doc requires `expectedTurnId` as a
  correctness-critical param (`turn/steer` live example: `{"threadId":...,"expectedTurnId":"not-active",
  "input":[...]}`, error `-32600 No active turn for thread ...` when it doesn't match). Neither reference client
  demonstrates handling that `expectedTurnId` race explicitly; omomaki's own `turn/steer` usage should be built
  directly against senpi's documented error path rather than copied uncritically from CodexRemote's summary.
- **Approval decision vocabulary**: senpi's doc states command approval decisions are exactly `accept`,
  `acceptForSession`, `decline`, `cancel` (camelCase-run-together style, e.g. `acceptForSession`). The lab repo
  only ever sends `{decision: "accept"}` or `{decision: "decline"}}` — it never uses `acceptForSession` or
  `cancel` even though its UI has a "sandbox mode" selector, meaning its approval UX is strictly binary.
  CodexRemote's `buildApprovalResult()` does construct `acceptForSession`/`acceptAlways`/`accept` variants but
  those exact string spellings are Codex-CLI-specific per `http/mapping.ts` and were not cross-checked against
  senpi's spelling in the source read here — **omomaki should verify exact decision string casing
  (`acceptForSession` vs `accept_for_session` etc.) against senpi's live wire format, not assume either repo's
  strings transfer as-is.**
- **No-subscriber approval auto-decline**: senpi's doc states "If no subscriber is attached, the approval is
  declined with a no-subscriber reason." CodexRemote's fail-closed-on-missing-`chatId` behavior
  (`http/server.ts` ~L1841-1846, respond with `"decline"`) is functionally consistent with this senpi behavior
  even though CodexRemote targets Codex CLI's app-server, not senpi — a good sign the two servers converge here,
  but omomaki should still verify senpi's actual no-subscriber decline payload shape rather than assume string
  `"decline"` is correct (senpi's doc doesn't show the literal wire value for that decline).
- **Terminal-notification replay queue**: senpi's doc documents that `turn/completed` and `error` notifications
  are queued (capped at 100) and replayed to the next subscriber when no subscriber is attached at emission time.
  Neither reference repo's docs mention or rely on this replay behavior — the lab repo instead treats
  `upstream.on("close")` as fully terminal (`markUpstreamClosed()`, closes all browser clients) and CodexRemote
  relies on its own REST rehydration endpoints (`run-state`, `pending-approval`) rather than assuming app-server
  replays a queued `turn/completed`. **Omomaki should prefer building its own rehydration/state-recovery path
  (like CodexRemote §2 pattern 4) rather than depending solely on senpi's notification replay**, since replay is
  capped and scoped per-thread, not a general reconnect story.
- **`thread/start`/`thread/resume` params**: the lab repo sends Codex-CLI-flavored params
  (`approvalPolicy: "on-request"`, `sandbox: "workspace-write"` as a bare string) directly on `thread/start`.
  senpi's doc's own `thread/start` live example only shows `{cwd}` and returns a full thread object whose
  `sandbox` field is a *typed object* (`{"type":"dangerFullAccess"}`), not a bare string, and `approvalPolicy`
  is a top-level thread field returned in the response, not obviously an accepted *input* param in the shown
  example. **Omomaki must confirm against senpi's actual accepted `thread/start` param schema** rather than
  reuse the lab repo's Codex-CLI-shaped `{model, cwd, approvalPolicy, sandbox}` params verbatim — senpi's
  sandbox typing in particular (`{type: "workspaceWrite", writableRoots: [...], networkAccess, ...}` vs a bare
  string) matches the lab repo's `sandboxPolicyForMode()` *output* shape for `turn/start`'s `sandboxPolicy`
  param, but not necessarily what `thread/start` itself expects for its own `sandbox` param.
- **Config writes are unsupported in senpi** (`config/read` only, doc: "Configuration writes are deliberately
  unsupported"). CodexRemote's `PATCH /v1/runtime/config` writes `~/.codex/config.toml` directly via filesystem,
  bypassing app-server entirely for that operation — this is *not* an app-server RPC differential, it's a
  filesystem side-channel CodexRemote uses because Codex CLI's app-server doesn't expose config writes either.
  Confirms omomaki cannot rely on any app-server RPC (senpi or Codex CLI) for runtime config mutation.

---

## Sources Read

**codex-remote-control-lab:**
`_refs/codex-remote-control-lab/scripts/start-phone.js`,
`_refs/codex-remote-control-lab/scripts/phone-notify.js`,
`_refs/codex-remote-control-lab/scripts/bridge-state.js` (referenced),
`_refs/codex-remote-control-lab/scripts/history-sync.js` (referenced),
`_refs/codex-remote-control-lab/package.json`,
`_refs/codex-remote-control-lab/README.md`,
`_refs/codex-remote-control-lab/docs/guide/protocol.md`,
`_refs/codex-remote-control-lab/docs/guide/phone-bridge.md`,
`_refs/codex-remote-control-lab/docs/guide/security.md`.

**CodexRemote:**
`_refs/CodexRemote/packages/protocol/src/index.ts`,
`_refs/CodexRemote/apps/mac-companion/src/codex/client.ts`,
`_refs/CodexRemote/apps/mac-companion/src/auth/token-store.ts`,
`_refs/CodexRemote/apps/mac-companion/src/pairing/pairing-store.ts`,
`_refs/CodexRemote/apps/mac-companion/src/http/server.ts`,
`_refs/CodexRemote/apps/mac-companion/src/http/mapping.ts` (referenced via grep),
`_refs/CodexRemote/docs/architecture.md`,
`_refs/CodexRemote/docs/api.md`.

**omo/senpi app-server reference:**
`/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/docs/app-server.md`.
