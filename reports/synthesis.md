# Kimaki → Omomaki Synthesis

Sources cited (all under `/home/whrho/git/omomaki/reports/`):
- `kimaki-discord-layer.md` — Discord client, bootstrap, channel→project / thread→session, SQLite, gateway-proxy client integration
- `kimaki-opencode-integration.md` — OpenCode SDK v2 usage, shared `opencode serve`, plugins, Hrana SQLite, session lifecycle
- `kimaki-features.md` — user-facing feature inventory
- `kimaki-packages.md` — pnpm workspace, dual-runtime DB package, test harness
- `omo-appserver.md` — omo app-server JSON-RPC: transports, auth, methods, thread/turn lifecycle, JSONL layout
- `codex-remote-refs.md` — two remote-client reference implementations; design patterns to copy

---

## 1. High-level port strategy

**Keep the Discord control surface.** All of kimaki's UX (slash commands, mention-mode routing, thread=session, `.queue`/`.btw` suffix detection, file modals, voice transcription) is built on discord.js. Port = backend-only.

**Replace the OpenCode SDK with the omo app-server JSON-RPC.** Kimaki's heaviest runtime dep is `@opencode-ai/sdk/v2` (29 import sites, `kimaki-opencode-integration.md` §2): `session.create/get/messages/promptAsync/command/abort/status`, `provider.list`, `app.agents`, `config.get`, plus one shared `opencode serve` per data dir (§1, §5). The omo app-server exposes a Codex-compatible JSON-RPC with `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/read`, `thread/list`, `model/list`, `skills/list`, `mcpServerStatus/list`, `config/read`, `thread/settings/update`, and `turn/diff/updated` notifications (`omo-appserver.md` §3). Stand up one `omo app-server` daemon per bot instance (stdio child or `ws://` with bearer token) instead of one `opencode serve`. `session.create`/`get` → `thread/start`/`resume` (cwd = project dir); `session.promptAsync` → `turn/start`/`steer`; `session.abort` → `turn/interrupt`; `session.fork` → `thread/fork`; `session.messages` → `thread/read`; `turn/diff/updated` covers diffs. Per-directory SDK client cache → per-cwd thread affinity (omo threads are already pinned to a `cwd`).

**Keep or drop the gateway-proxy?** Trade-off. kimaki's Rust gateway-proxy (`kimaki-discord-layer.md` §5; `kimaki-packages.md` §3 `gateway_clients` table) lets multiple users share one Discord bot. The submodule is uninitialized locally, but client-side integration code is in place (`discord-urls.ts:76-88`, `cli-runner.ts:1651-1653`, `schema.ts:60-69`). **Recommendation: drop the gateway-proxy from Phase 0–2** (single-tenant self-hosted, well-understood path) and **re-add in Phase 3** if multi-tenant shared-bot demand exists. The Rust source must be fetched (`git submodule update --init gateway-proxy`) before any gateway work.

---

## 2. Component map

| Kimaki component | Kimaki file(s) | omo primitive | Adaptation notes | Risk |
|---|---|---|---|---|
| Discord.js bot + event loop | `cli/src/discord-bot.ts`, `cli/src/cli.ts` | Keep as-is | Backend-only port | Low |
| Shared OpenCode server | `cli/src/opencode.ts`, `cli/src/hrana-server.ts`, `cli/src/cli-runner.ts:1569-1769` | `omo app-server` daemon (stdio:// or ws://) | Replace `createOpencodeClient` + `ensureSingleServer` with one JSON-RPC transport; per-directory → per-cwd threads | Medium |
| `session.create`/`get` | `thread-session-runtime.ts:4325-4368` | `thread/start` / `thread/resume` | omo `thread.id == session.id`; kimaki's `setThreadSession` SQLite mapping collapses to identity | Medium |
| `session.promptAsync` | `thread-session-runtime.ts:3199-3220` | `turn/start` + `turn/steer` | Discord emitter subscribes to omo `item/*` notifications | Medium |
| `session.command` | `thread-session-runtime.ts:4098` | `turn/start` with skill/MCP context | omo turn input richer; verify file-part parity | Medium |
| `session.abort` + interrupt replay | `opencode-interrupt-plugin.ts`, `thread-session-runtime.ts:3522` | `turn/interrupt` + `turn/steer` (replay) | Move 3s timer from agent process to bot process; replay via `turn/steer` or fresh `turn/start` | Medium-High |
| `provider.list` / `app.agents` | `session-handler/{model,agent}-utils.ts` | `model/list`, `config/read`, `thread/settings/update` (model+effort), `skills/list` | omo returns reasoning-effort/service-tier; agents → skills | Medium |
| Anthropic/OpenAI/XAI OAuth plugins | `cli/src/{anthropic,openai,xai}-auth-plugin.ts`, `opencode-kimaki-plugin/src/index.ts` | omo model config (§5) | Plugins ran inside agent process; credentials move to omo provider config; rotation moves to bot process | High |
| Context-awareness plugin | `cli/src/context-awareness-plugin.ts` | Bot-side context injection or skill | No `chat.message` hook analog in omo — bot process or skill wrapper | Medium |
| Cache-drift plugin | `cli/src/cache-drift-plugin.ts` | Bot-side prompt diff over JSONL/TurnLog | Snapshot/diff logic moves from agent to bot | Low-Medium |
| Hrana SQLite server | `cli/src/hrana-server.ts`, `cli/src/db.ts`, `cli/src/schema.ts` | Drop entirely; replace with bot-side local store + omo sessions dir | Hrana was DB + single-instance lock + `/kimaki/wake` + `/kimaki/opencode-port`; remove | High |
| Channel→project mapping | `cli/src/channel-management.ts`, `channel_directories` | Bot-side config → cwd for `thread/start` | Survives as bot config | Low |
| Thread→session mapping | `thread_sessions`, `discord-bot.ts:1218-1298` | omo `thread.id == sessionId`; bot keeps thread→threadId map | Kimaki's `/resume` rebind (non-unique session_id) → `thread/resume` + `thread/fork` | Medium |
| Slash command registration | `discord-command-registration.ts`, `interaction-handler.ts`, `cli/src/commands/*.ts` (49 files, 15,150 LOC) | Keep; backends call omo JSON-RPC | Low |
| `.queue` / `.btw` suffix detection | `commands/{queue,btw}.ts`, `message-preprocessing.ts`, `btw-prefix-detection.ts` | Queue → `turn/steer` (active) + bot-side pending queue (idle); btw → `thread/fork` + `turn/start` | `turn/steer` errors if no active turn — bot must hold queue while idle | Medium |
| Worktrees | `commands/new-worktree.ts`, `worktrees.ts`, `git-worktree-core.ts` | `cwd` on `thread/start`/`resume`/`fork` + bot-side git worktree | omo threads carry `cwd`; worktree = bot creates path, then starts thread with that cwd | Medium |
| Diff viewer (`/diff`) | `commands/diff.ts`, `critique-utils.ts` | `turn/diff/updated` notification + bot-side critique CLI | Turn diffs via omo notification; git diff URL stays bot-side | Low |
| Voice messages + realtime voice | `voice*.ts`, `cloudflare-transcription.ts`, `openai-realtime.ts` | Turn input audio part + bot-side transcription | Transcribe bot-side, send as turn input; realtime voice = separate worker, port/drop decision | Medium |
| Images | `image-utils.ts`, `image-optimizer-plugin.ts` | Turn input image part + bot-side preprocessing | Preprocess bot-side, send as file part | Low-Medium |
| Tunnels (screenshare/VNC/VS Code) | `cli-commands/user.ts`, `commands/{screenshare,vscode}.ts`, `traforo` | Keep bot-side | Infrastructure, not agent runtime | Low |
| Scheduled tasks | `task-schedule.ts`, `task-runner.ts`, `commands/tasks.ts`, `scheduled_tasks` | Bot-side cron/at scheduler wrapping `thread/start` + `turn/start` | Omo has no scheduler — wrap; concurrency via thread status; pre-run shell = bot exec | Medium-High |
| File upload tool (IPC modal) | `commands/file-upload.ts`, `ipc-polling.ts`, `ipc-tools-plugin.ts` | Keep bot-side | No omo primitive needed | Low |
| Onboarding wizard | `cli.ts`, `cli-runner.ts`, `onboarding-*.ts` | Bot-side wizard (self-hosted); drop gateway OAuth if dropping gateway | Depends on gateway decision | Medium |
| IPC polling / `/kimaki/wake` | `ipc-polling.ts`, `discord-urls.ts` | Drop or replace with omo notifications / bot-side polling | Hrana removal touches this | Medium |
| Maintenance (`/restart-opencode-server`, `/upgrade`) | `commands/{restart-opencode-server,upgrade}.ts` | omo runtime restart + bot self-upgrade | Map restart to omo app-server restart; upgrade stays bot-side | Low |
| Access control (roles) | `discord-utils.ts:42-147`, `discord-bot.ts:607-616` | Keep bot-side | No omo primitive | Low |
| Message formatting (⬥/┣/⬦/footer) | `message-formatting.ts`, `discord-bot.ts` | Bot-side rendering of omo `item/*` + thread metadata | Render from omo notifications; footer info from thread object | Low |

---

## 3. Feature parity mapping

| Feature (per `kimaki-features.md`) | omo surface | Notes |
|---|---|---|
| Scheduled tasks | Bot-side cron/at scheduler wrapping `thread/start` + `turn/start` | Pre-run shell = bot exec; concurrency = `thread/start` then poll `thread.read.status`; claim/retry/run-history in new bot-side store |
| Queue (`. queue` / `/queue`) | `turn/steer` (active) + bot-side pending queue (idle) | `turn/steer` returns error if no active turn; Remove button = cancel bot-side item or `turn/interrupt` |
| btw (`. btw` / `/btw`) | `thread/fork` + `turn/start` | Fork current thread with model override; worktree-aware cwd via bot-side; copy model via `thread/settings/update` |
| Worktrees (`/new-worktree`, `--use-worktrees`) | `cwd` on `thread/start`/`resume`/`fork` + bot-side git worktree | `--use-worktrees` = always pass worktree cwd; `/merge-worktree` = bot-side git rebase/squash + AI conflict resolution |
| Diff viewer (`/diff`) | `turn/diff/updated` notification + bot-side critique CLI | Turn diffs via omo notification; git diff URL stays bot-side |
| Voice messages | Turn input audio part + bot-side transcription | Bot transcribes, sends transcription text; realtime voice = separate worker, port/drop decision |
| Images | Turn input image part + bot-side preprocessing | Move sharp/heic conversion to bot; send as file part |
| OpenCode commands as slash commands | `skills/list`, `turn/start` (skill invocation), `mcpServerStatus/list` | Map slash commands to skill invocation; MCP prompts → MCP tool use in turn |
| Shell commands (`!` / `/run-shell-command`) | Bot-side exec | Intercepted before session; not agent-runtime — keep as-is |
| Tunnels (screenshare/VNC/VS Code) | Bot-side | Infrastructure — keep |
| Model & agent switching | `model/list`, `config/read`, `thread/settings/update` (model+effort only — partial), skills | Agent quick-commands → skill + model override; account rotation moves bot-side |
| Message interrupt (3s abort) | `turn/interrupt` + `turn/steer` replay | Move 3s timer from agent process to bot; replay = re-submit original parts via `turn/steer` or fresh `turn/start`; abort confirmation via thread status |
| Onboarding wizard | Bot-side wizard (self-hosted); drop gateway OAuth if dropping gateway | Depends on gateway decision |
| Session abort (`/abort`) | `turn/interrupt` | Resume = `turn/start` empty/no parts |
| Access control | Bot-side Discord role checks | No omo primitive — keep |
| Session lifecycle (channels=projects, threads=sessions) | `thread/start`/`resume`/`fork`/`read`/`list`/`archive`/`compact/start`/`name/set` | channel→cwd bot config; thread methods replace kimaki session lifecycle |
| File upload tool | Bot-side file picker | No omo primitive — keep |
| Maintenance (`/restart-opencode-server`, `/upgrade`) | omo runtime restart + bot self-upgrade | Map restart to omo app-server restart; upgrade stays bot-side |
| Typing indicator (7s refresh) | Bot-side, driven by omo turn lifecycle | Keep bot-side; trigger from `turn/started`/`item/*` notifications |
| Message formatting (⬥/┣/⬦/footer) | Bot-side rendering of omo `item/*` + thread metadata | Render from omo notifications; footer model/info from `thread.read` response |

---

## 4. Data migration — SQLite `discord-sessions.db` → omo sessions dir

Kimaki source: `<dataDir>/discord-sessions.db` (Drizzle/libSQL via Hrana, `cli/src/db.ts:53-107`). Omo destination: `${OMO_AGENT_DIR:-~/.omo/agent}/sessions/{slug}/{ISO timestamp}_{threadId}.jsonl` (`omo-appserver.md` §4, §6; `thread.id == sessionId`).

| Kimaki table | Migration |
|---|---|
| `channel_directories` (channel→project) | Bot-side config (JSON/SQLite); survives as cwd source for `thread/start` |
| `thread_sessions` (thread→session) | `thread_id` → omo `thread.id`/`sessionId`; session content → JSONL; `source` → JSONL sidecar |
| `session_events`, `part_messages` | Serialize into omo JSONL items (heaviest transform — migrate active/recent only; leave archives read-only) |
| `thread_workspaces`/`thread_worktrees` | cwd in JSONL sidecar (via `thread/metadata/update` or custom field); worktree git machinery recreated bot-side |
| `channel_models`/`session_models`, `channel_agents`/`session_agents` | omo `config/read` + `thread/settings/update` (partial: model + effort) + skill selection |
| `scheduled_tasks`/`scheduled_task_runs` | New bot-side store (JSON/SQLite); omo has no scheduler — wrap externally |
| `session_sleeps` | Bot-side durable wake-later state (new store) or drop |
| `bot_tokens` | Omo model config / provider credentials (§5) — do not migrate verbatim |

Hrana removal: single-instance lock → bot-side pid/port file; DB → bot-side store; `/kimaki/wake` → omo notification or bot-side health endpoint. Drop Hrana entirely.

---

## 5. Auth migration — Claude Pro/Max OAuth plugins → omo model config

Kimaki runs Anthropic/OpenAI/XAI OAuth plugins inside the OpenCode server process (`kimaki-opencode-integration.md` §3): `auth.provider: "anthropic"` loader zeroes cost fields for OAuth users, rewrites tool names to Claude Code names, injects beta headers, performs OAuth refresh + multi-account rotation on 429. Omo's `account/read` returns `{type:"apiKey"}` only; `account/rateLimits`/`usage` are intentionally unsupported (`omo-appserver.md` §3). Kimaki's differentiator is subscription loading (Claude Pro/Max) + rotation.

1. **Credentials.** Move OAuth tokens/refresh state from kimaki auth-state files to omo model config / provider credential storage. Do not carry kimaki tables forward.
2. **OAuth flows.** Port PKCE/rotation to bot process (or credential sidecar); store refreshed credentials in omo model config. Recommend preserving Claude Pro/Max subscription UX (Option A) over dropping rotation.
3. **Tool-name/beta-header rewriting.** Kimaki's request shaping ran inside the agent process. With omo, must move to bot-side shim or be dropped — omo's provider-request path is not an in-agent-process plugin anymore. Verify omo's provider path; if missing, add a bot-side translation layer.
4. **`account/read` parity.** Subscription cost-field zeroing is kimaki-specific; omo `account/read` is apiKey-only. Cost display moves bot-side (kimaki's footer already renders session metadata).
5. **Session identity stamping.** Kimaki stamps `x-kimaki-session-id`; omo's `thread.id == sessionId` is the identity — if provider-side tagging is needed, emit from bot, or drop if omo handles internally.

---

## 6. Design patterns to adopt from the remote-control references

`codex-remote-refs.md` reviews two reference implementations of remote clients for the Codex CLI app-server protocol: `codex-remote-control-lab` (Node phone bridge) and `CodexRemote` (Mac companion + iOS client). Patterns most relevant to omomaki (a Discord bot driving omo/senpi app-server):

1. **Keep app-server on loopback; expose only a thin token-checked surface.** Both refs keep the Codex app-server subprocess on `127.0.0.1`/stdio; only a small authenticated bridge is reachable from the network. Omomaki should keep the omo app-server subprocess on `127.0.0.1`/stdio and let Discord (already an authenticated transport) be the only public-facing surface — never bind the app-server socket to `0.0.0.0`.
2. **One shared upstream connection multiplexed to N clients, keyed by thread id with late-promotion.** `codex-remote-control-lab`'s `SharedBridge` keys by `bridgeKey` in a Map, then promotes to the real `threadId` once `thread/start`/`thread/resume` resolves. Reuse for mapping Discord channel/thread IDs to omo `threadId`s before the id is known. Replay full state on late join.
3. **Normalize approval requests into a provider-agnostic shape before they reach the UI layer.** `CodexRemote`'s `mapApprovalRequest()` + shared `ApprovalRequest` type (`kind`, `mode`, `riskLevel`, `supportsSessionAllow`, `supportsAlwaysAllow`) is a much cleaner boundary than forwarding raw JSON-RPC to Discord. Omomaki should build one normalized "approval card" schema and map every omo `*requestApproval` server-request into it, so Discord embed/button code never branches on raw method names.
4. **Fail closed on missing routing context.** `CodexRemote` auto-declines approvals it can't map to a known chat (`if (!chatId) { respond(event.id, "decline"); }`). Omomaki should adopt the same default-deny for orphaned approval requests — never silently drop or leave omo hanging.
5. **Generic approval-suffix detection + explicit decision mapping.** `codex-remote-control-lab` uses `msg.method.endsWith("/requestApproval")` to cover all approval kinds; combine with `CodexRemote`'s per-method `buildApprovalResult()` to map decision → `{decision: "accept"|"decline"|"acceptForSession"|"acceptAlways"|"cancel"}` based on the specific request method (senpi's app-server supports all four command-approval decisions, not just binary accept/decline).
6. **REST rehydration endpoints alongside the live event stream.** `CodexRemote` exposes `GET /v1/chats/{chatId}/run-state` and `GET /v1/chats/{chatId}/pending-approval` so late/reconnecting clients can recover current state without racing the event stream. Omomaki should expose (internally) an equivalent "what is this thread's current turn/approval state right now" query path via `thread/read` + `thread/turns/list`, independent of notification delivery.
7. **Persisted "always allow" scoped by tool/server fingerprint.** `CodexRemote`'s `enableAlwaysAllow(scopeKey)` scopes trust to a specific MCP server+tool pair, stored locally, surviving restarts. For omomaki: equivalent "always allow this command pattern for this user/guild" preference rather than blanket trust.
8. **Bearer token in header, not URL query string.** `CodexRemote` uses `Authorization: Bearer <token>` on WS upgrade plus `chatId` in query only. If omomaki ever needs a non-Discord bridge surface, follow this — not the lab repo's `?token=` pattern (avoids token leakage via logs/referrers/history).
9. **Hash stored tokens, compare with constant-time equality.** `CodexRemote`'s `TokenStore` never persists raw tokens (`sha256(token)` only) and uses `safeTokenEqual()`. Directly applicable if omomaki stores any bot-issued secrets (per-guild API keys) on disk.
10. **Local-path image attachments, not inline base64 into RPC.** `codex-remote-control-lab`'s `saveDataUrlAttachment()` downloads attachments to a local `.uploads/` dir (tight permissions, randomized names) and passes `{type:"localImage", path}` in `turn/start` input. Mirrors exactly what omomaki needs for Discord image messages — avoids inflating JSON-RPC payloads and matches how app-server expects local images.
11. **Push-notification hooks on `approval`/`completed`/`failed` bridge events.** `codex-remote-control-lab`'s `notifyRunEvent()` + `phone-notify.js` multi-provider webhook fan-out (ntfy/Pushover/Discord) is a ready template for omomaki's own "ping the Discord channel when a turn needs approval or finishes" behavior — note it already posts to Discord webhooks, so `taskNotificationMessage()` is a reasonable starting schema.

---

## 7. Phased milestones

### Phase 0 — Scaffold (single-tenant, self-hosted, no gateway)

Scope: bootstrap with `omo app-server` stdio child instead of `opencode serve`; replace SDK singleton with JSON-RPC transport; core session lifecycle (`thread/start`/`resume`/`fork`/`turn/start`/`steer`/`interrupt`/`thread/read`); Discord message ↔ `turn/start` + omo `item/*` notifications; model resolution via `model/list`/`config.read`/`thread/start` model override. No gateway, no OAuth rotation, no worktrees, no scheduled tasks, no voice/real-time.

Acceptance: message in kimaki channel/thread starts omo thread (cwd = channel's project dir), submits prompt via `turn/start`, Discord message streams from omo notifications, final output reflects `turn/completed`. `thread/list`/`resume`/`fork` work. `turn/steer` queues, `turn/interrupt` aborts. Model switching via `thread/start` override. One omo runtime serves multiple project dirs via per-cwd threads. `turn/diff/updated` flows through to bot. Send `capabilities.experimentalApi: true` in `initialize` to gate any experimental methods used later.

### Phase 1 — Discord→omo bridge

Scope: `.queue` (bot-side pending queue for idle + `turn/steer` for active); `.btw` (`thread/fork` + `turn/start`); `/model`+`/agent` (`model/list`, `config/read`, `thread/settings/update`, skills); `/diff` (critique CLI bot-side + `turn/diff/updated`); images (bot preprocessing + turn input); voice (bot transcription + turn input audio part, decide realtime port/drop); skills/MCP as slash commands; message formatting (omo `item/*` → Discord parts); typing indicator from omo lifecycle; file upload modal stays bot-side; tunnels stay bot-side. Move 3s abort timer + replay from agent to bot process.

Acceptance: queue/btw/model-agent/diff/images/voice/commands-skills-MCP all behave as in kimaki, backed by omo. Message formatting matches kimaki's Discord style from omo notifications. Interrupt path: bot-side timer → `turn/interrupt` → replay via `turn/steer`/`turn/start`; abort confirmed via thread status polling. Hrana removed; bot state is a small local store; single-instance lock is bot-side. Approval cards rendered from normalized `*requestApproval` events (§6 patterns 3-5).

### Phase 2 — Feature parity (worktrees, scheduled tasks, auth, migration)

Scope: worktrees (bot-side git worktree + cwd on `thread/start`/`resume`/`fork`; `/merge-worktree` = bot-side git rebase/squash + AI conflict resolution; `--use-worktrees` global); scheduled tasks (bot-side cron/at wrapping `omo app-server`; pre-run shell, concurrency gate via thread status, claim/retry/run-history in new store); auth migration §5 (port Anthropic/OpenAI/XAI OAuth + rotation to bot-side, omo model config); data migration §4 (active sessions → omo JSONL; channel→project as bot config; model/agent prefs → omo config/thread settings; scheduled-task state recreated).

Acceptance: worktree creation/merge + `--use-worktrees` work; scheduled task runs on schedule, dispatches prompt, records run history, concurrency gate prevents overlap. OAuth login (Claude Pro/Max) works; multi-account rotation on rate limits; subscription models selectable. Existing kimaki sessions resumable in omo after migration via `thread/resume` from migrated JSONL. Rehydration path (§6 pattern 6) returns correct state for late-joining clients.

### Phase 3 — Hardening

Scope: transport reconnect (ws:// or stdio restart); thread idle-unload handling (omo's 30-min idle unload, JSONL persistence); subscription-loss handling for Discord streaming; terminal notification queuing (omo caps 100/thread); omo runtime start/stop/restart mapped to kimaki's restart/upgrade flows; observability (session JSONL + TurnLog audit trail, bot-side logs for queue/btw/interrupt/scheduler); optional gateway-proxy re-integration if multi-tenant required (initialize the git submodule first); replace Hrana `/kimaki/wake` with omo notification or bot-side health endpoint. Apply remote-control patterns §6.7-11 if a non-Discord bridge surface is added.

Acceptance: after omo reconnect/restart, active Discord streaming resumes (no duplicates, no lost terminals beyond cap); idle-unload preserves resume (JSONL); in-process TurnLog survives idle unload; restarting omo runtime preserves channel→project mapping and queued/scheduled state. If gateway-proxy re-added, multi-tenant guild routing works per `website/src/docs/docs/reference/gateway-architecture.mdx`. No `libsql`/Hrana imports remain in the bot. All tokens hashed on disk; WS auth uses header (not query string) if any bridge added.

---

*End of synthesis. All six digest files cited by path at top.*
