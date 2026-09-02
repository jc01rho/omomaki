# Kimaki OpenCode Integration Audit

Scope: `/home/whrho/git/omomaki/_refs/kimaki` (a git submodule/vendor checkout of the `kimaki` Discord bot). All line numbers are as of the current checkout snapshot. Every claim below cites `path:line` or `path:startLine-endLine`.

---

## 1. OpenCode client creation

Kimaki runs **one shared `opencode serve` process** for all project directories and scopes every SDK call to a directory via the `x-opencode-directory` header / `directory` param. The actual client-creation code lives in `cli/src/opencode.ts`, not in `cli-runner.ts` — `cli-runner.ts`, `wait-session.ts`, and `task-runner.ts` are all *consumers* of `initializeOpencodeForDirectory()`.

- **`cli/src/opencode.ts:1-20`** — module banner: "ONE opencode serve process shared by all project directories. Each SDK client uses the x-opencode-directory header to scope requests to a specific project."
- **`cli/src/opencode.ts:50-56`** — imports `createOpencodeClient`, `OpencodeClient`, `Config as SdkConfig`, `PermissionRuleset` from `@opencode-ai/sdk/v2`.
- **`cli/src/opencode.ts:592-608`** (`getOrCreateClient`) — builds the actual client:
  ```ts
  const client = createOpencodeClient({
    baseUrl, directory,
    fetch: fetchWithTimeout as typeof fetch,
    headers: getOpencodeServerAuthHeaders(),
  })
  clientCache.set(directory, client)
  ```
  Cached per-directory in a `Map<string, OpencodeClient>` (`cli/src/opencode.ts:583`, `clientCache`).
- **`cli/src/opencode.ts:618-645`** (`initializeOpencodeForDirectory`) — public entry point: validates directory access, calls `ensureSingleServer({ directory })` to lazily spawn/discover the shared server, and returns a **client factory** `() => OpencodeClient` (not the client itself) so callers always get a live client bound to `singleServer.baseUrl`.
- **`cli/src/opencode.ts:474-520`** (`ensureSingleServer`) — dedupes concurrent startup attempts via a shared `startingServer` promise; first tries `discoverExistingServer()` (queries the bot's Hrana server for a running OpenCode server on a well-known port before spawning a new one), else calls `startSingleServer`.
- **`cli/src/opencode.ts:429-472`** (`discoverExistingServer`) — CLI subcommands reuse the bot's OpenCode server by hitting `/kimaki/opencode-port` on the Hrana lock port instead of spawning a redundant server.

### Consumers (per the requested audit list)

- **`cli/src/cli-runner.ts:604-641`** (`backgroundInit`) — calls `initializeOpencodeForDirectory(currentDir)` (via `discord-bot.ts`'s re-export `initializeOpencodeForDirectory`, imported at `cli/src/cli-runner.ts:33`), then `getClient().command.list({ directory })` and `getClient().app.agents({ directory })` to register Discord slash commands.
- **`cli/src/opencode-command.ts`** — does **not** create an OpenCode SDK client at all. It only resolves the `opencode`/`bun` binary paths on `PATH` (`selectResolvedCommand`, `getSpawnCommandAndArgs`, lines 15-45) and builds a `kimaki` command shim (`ensureKimakiCommandShim`, lines 118-160) that OpenCode's own child processes can invoke to re-enter kimaki (guarded via `KIMAKI_OPENCODE_PROCESS`). It is consumed by `opencode.ts` (`cli/src/opencode.ts:14` imports `ensureKimakiCommandShim`, `getPathEnvKey`, `getSpawnCommandAndArgs`, `prependPathEntry`, `selectResolvedCommand` from `./opencode-command.js`) when spawning the server (`cli/src/opencode.ts:440-451`).
- **`cli/src/wait-session.ts:1-9`** — imports `Message as OpenCodeMessage` type from `@opencode-ai/sdk/v2` and `initializeOpencodeForDirectory` from `./opencode.js`.
  - **`cli/src/wait-session.ts:64-72`** (`waitForSessionComplete`) — calls `initializeOpencodeForDirectory(projectDirectory)`, then polls `getClient().session.status({ directory })` (`wait-session.ts:80`) and `getClient().session.messages({ sessionID, directory })` (`wait-session.ts:88`) every 5s until the session is idle, its latest user turn completed naturally, and no interactive permission prompts are pending.
  - **`cli/src/wait-session.ts:155-163`** (`outputSessionMarkdown`) — re-initializes the client, feeds it into `new ShareMarkdown(getClient())` to render a session transcript.
- **`cli/src/task-runner.ts:27`** — imports `initializeOpencodeForDirectory` from `./opencode.js`.
  - **`cli/src/task-runner.ts:420-435`** (`hasRunningSession`) — for each active scheduled-task run, calls `initializeOpencodeForDirectory(run.project_directory)` then `getClient().session.status({ directory })` to decide whether a prior scheduled run is still active (used for the task runner's concurrency gate).

---

## 2. SDK v2 imports (`@opencode-ai/sdk/v2`)

29 files under `cli/src` import from `@opencode-ai/sdk/v2` (excluding `*.test.ts`):

```
cli/src/anthropic-auth-plugin.ts
cli/src/anthropic-auth-state.ts
cli/src/cli-commands/{bot,maintenance,misc,project,send,session,task,user}.ts
cli/src/commands/{mcp,permissions,restart-opencode-server,undo-redo}.ts
cli/src/discord-command-registration.ts
cli/src/discord-utils.ts
cli/src/external-opencode-sync.ts
cli/src/markdown.ts
cli/src/message-formatting.ts
cli/src/openai-auth-plugin.ts
cli/src/openai-auth-state.ts
cli/src/opencode-interrupt-plugin.ts
cli/src/opencode.ts
cli/src/plugin-opencode-client.ts
cli/src/session-handler/event-stream-state.ts
cli/src/session-handler/global-event-listener.ts
cli/src/session-handler/opencode-session-event-log.ts
cli/src/session-handler/thread-session-runtime.ts
cli/src/session-search.ts
cli/src/tools.ts
cli/src/wait-session.ts
cli/src/xai-auth-plugin.ts
cli/src/xai-auth-state.ts
```

Representative import sites:
- **`cli/src/opencode.ts:50-56`** — `createOpencodeClient`, `OpencodeClient`, `Config as SdkConfig`, `PermissionRuleset`.
- **`cli/src/plugin-opencode-client.ts:19`** — `import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'`.
- **`cli/src/session-handler/global-event-listener.ts:9-10`** — `import type { Event as OpenCodeEvent, GlobalEvent } from '@opencode-ai/sdk/v2'` and `import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'`.
- **`cli/src/opencode-interrupt-plugin.ts:29-35`** — `import type { Part, TextPartInput, FilePartInput, AgentPartInput, SubtaskPartInput } from '@opencode-ai/sdk/v2'`.
- **`cli/src/wait-session.ts:9`** — `import type { Message as OpenCodeMessage } from '@opencode-ai/sdk/v2'`.
- **`cli/src/anthropic-auth-plugin.ts:29`** — `import type { OpencodeClient } from "@opencode-ai/sdk/v2"`.

Note there is **no `@opencode-ai/sdk/v1`** or non-versioned import anywhere in the plugin/client code — `plugin-opencode-client.ts:1-16` explicitly documents that the plugin-provided v1 client (`ctx.client` from `@opencode-ai/plugin`) is unreliable for REST calls inside the OpenCode server process, so every plugin builds its own v2 client via `createPluginClient({ serverUrl, directory })`.

---

## 3. Plugins

All OpenCode plugins are TypeScript modules exporting a `Plugin` (`@opencode-ai/plugin` type) function; each export from the aggregator file `cli/src/kimaki-opencode-plugin.ts` is loaded as an independent plugin by OpenCode's plugin loader (comment at `cli/src/kimaki-opencode-plugin.ts:1-3`). They are registered into the spawned server's config at **`cli/src/opencode.ts:492-497`**:
```ts
plugin: [
  new URL(isDev ? './kimaki-opencode-plugin.ts' : './kimaki-opencode-plugin.js', import.meta.url).href,
  resolveSubrouterPluginSpec({ isDev }),
],
```

### `cli/src/kimaki-opencode-plugin.ts` (aggregator, 30 lines)
- **`cli/src/kimaki-opencode-plugin.ts:14-30`** re-exports: `ipcToolsPlugin`, `contextAwarenessPlugin`, `memoryOverviewPlugin`, `interruptOpencodeSessionOnUserMessage`, `anthropicAuthPlugin`, `openaiRotationPlugin`, `xaiRotationPlugin`, `imageOptimizerPlugin`, `subagentRateLimitPlugin`, `cacheDriftPlugin`, `kittyGraphicsPlugin` (from external pkg `kitty-graphics-agent`), `injectionGuardInternal as injectionGuard` (from `opencode-injection-guard`), `kimakiWorkspaceAdaptorPlugin`.

> Task-requested path `opencode-kimaki-plugin/src/index.ts` is a **separate, smaller, standalone npm package** (`opencode-kimaki-plugin/package.json`) distinct from `cli/src/kimaki-opencode-plugin.ts`. See its own section below.

### `cli/src/opencode-interrupt-plugin.ts`
Interrupts a busy session when a new user message arrives, aborts the in-flight generation, then replays the queued message.
- **`cli/src/opencode-interrupt-plugin.ts:1-20`** — banner explains it runs *inside the opencode server child process* and builds its own v2 client from `ctx.serverUrl` because `ctx.client` (v1) silently no-ops REST calls in that process.
- **`cli/src/opencode-interrupt-plugin.ts:87-89`** — `createPluginClient({ serverUrl: ctx.serverUrl, directory })`, `createPluginAppLogger(...)`.
- **`cli/src/opencode-interrupt-plugin.ts:159`** — `await client.session.abort({ sessionID, directory })`.
- **`cli/src/opencode-interrupt-plugin.ts:130-142`** (`waitForSessionIdle`) — polls `client.session.status({ directory })` every 100ms up to 3s to confirm the session actually went idle after abort (event-based waiting was found unreliable, per comment at lines 25-30).
- **`cli/src/opencode-interrupt-plugin.ts:195`** — `await client.session.promptAsync(replayParams)` replays the original parts + agent/model overrides, since `session.abort` clears OpenCode's internal prompt queue.
- **`cli/src/opencode-interrupt-plugin.ts:225-283`** — hooks: `event()` clears pending timers on `message.updated`/`session.deleted`/`session.idle`; `'chat.message'(input, output)` schedules a delayed interrupt (`DEFAULT_INTERRUPT_STEP_TIMEOUT_MS = 3_000`, line 46) unless the message was just replayed.

### `cli/src/context-awareness-plugin.ts`
Injects synthetic (TUI-hidden, model-visible) message parts: git branch/detached-HEAD changes, working-directory changes, a MEMORY.md reminder after large replies, onboarding tutorial text, and the kimaki system prompt fallback for `session.command`.
- **`cli/src/context-awareness-plugin.ts:66-78`** — minimal `PluginClient` type declares `session.get` and `session.messages` signatures used by this plugin.
- **`cli/src/context-awareness-plugin.ts:243`** — `const fullClient = createPluginClient({ serverUrl, directory })`.
- **`cli/src/context-awareness-plugin.ts:216-233`** (`resolveSessionDirectory`) — calls `client.session.get({ sessionID })` to detect directory changes mid-thread (e.g. after `/new-worktree`).
- **`cli/src/context-awareness-plugin.ts:329-336`** — calls `client.session.messages({ sessionID, directory, limit: 20 })` to find the latest assistant message for the MEMORY.md-reminder heuristic (`shouldInjectMemoryReminderFromLatestAssistant`, threshold `MEMORY_REMINDER_OUTPUT_TOKENS = 12_000` at line 141).
- **`cli/src/context-awareness-plugin.ts:257-386`** — the `'chat.message'` hook does, in order: system-prompt backfill for `session.command` path (269-280), tutorial injection (289-300), pwd-change injection (348-359), memory reminder injection (361-375), branch/detached-HEAD injection (378-386).
- **`cli/src/context-awareness-plugin.ts:389-412`** — `event` hook cleans up per-session state on `session.deleted`.

### `cli/src/anthropic-auth-plugin.ts`
Marked "LEGACY, superseded by `@subrouter/opencode`" (line 1) but still registered because it owns `anthropic/*` OAuth that opencode itself doesn't provide.
- **`cli/src/anthropic-auth-plugin.ts:29-30`** — imports `type { Hooks, Plugin } from "@opencode-ai/plugin"` and `type { OpencodeClient } from "@opencode-ai/sdk/v2"`.
- **`cli/src/anthropic-auth-plugin.ts:706`** — `const client = createPluginClient({ serverUrl, directory })` inside `AnthropicAuthPlugin`.
- **`cli/src/anthropic-auth-plugin.ts:709-712`** — `"chat.headers"` hook stamps `x-kimaki-session-id` on Anthropic requests only.
- **`cli/src/anthropic-auth-plugin.ts:714-720`** — `auth.provider: "anthropic"` with a custom `loader` that zeroes cost fields for OAuth (Claude Pro/Max subscription) users.
- **`cli/src/anthropic-auth-plugin.ts:725-810`** (`fetch` override inside the loader) — rewrites tool names to Claude Code names, prepends the Claude Code identity string, injects Anthropic beta headers, and performs OAuth token refresh + multi-account rotation on 429/permanent-failure responses (`shouldRotateAuth`, `rotateAnthropicAccount` from `./anthropic-auth-state.js`, imported at lines 33-42).
- **`cli/src/anthropic-auth-plugin.ts:865-877`** — separate exported plugin `replacer` implements `"experimental.chat.system.transform"` to strip the OpenCode identity block for Anthropic-model turns.
- **`cli/src/anthropic-auth-plugin.ts:879`** — `export { replacer, AnthropicAuthPlugin as anthropicAuthPlugin }`.

### `opencode-kimaki-plugin/src/index.ts` (standalone npm package, distinct from `cli/src/kimaki-opencode-plugin.ts`)
- **`opencode-kimaki-plugin/src/index.ts:1-27`** — banner: published as `@kimaki/opencode-plugin`, provides only the Anthropic OAuth PKCE flow (for users who want kimaki's Claude Pro/Max login without running the Discord bot). No SQLite/Discord dependency.
- **`opencode-kimaki-plugin/src/index.ts:29-33`** — re-imports `anthropicAuthPlugin as _anthropicAuthPlugin, replacer as _replacer` from `'kimaki/anthropic-auth-plugin'` (i.e. it wraps `cli/src/anthropic-auth-plugin.ts`'s exports rather than reimplementing them).
- **`opencode-kimaki-plugin/src/index.ts:37-46`** — both wrapped plugins short-circuit to `{}` when `process.env.KIMAKI` is set, to avoid double-registration when running inside the full kimaki bot (which already loads the real plugin via `cli/src/kimaki-opencode-plugin.ts:20`).

### `cli/src/cache-drift-plugin.ts`
Detects unintended system-prompt drift between turns (which silently discards Anthropic prompt caching).
- **`cli/src/cache-drift-plugin.ts:1-6, 8**` — imports `type { Plugin } from '@opencode-ai/plugin'` and `diffLines` from `diff`; no OpenCode SDK client is created (pure hook logic, no REST calls).
- **`cli/src/cache-drift-plugin.ts:114-121`** (`'chat.message'` hook) — snapshots the previous turn's system prompt into `SessionState.previousTurnPrompt` at the start of each new user turn.
- **`cli/src/cache-drift-plugin.ts:123-149`** (`'experimental.chat.system.transform'` hook) — debounces via `setTimeout(..., 0)` so it runs after other system-transform hooks (e.g. the Anthropic `replacer` above) have mutated `output.system`, then calls `handleSystemTransform` which diffs old vs. new prompt with `diffLines` and logs `+N/-M` line counts when changed unexpectedly (`shouldSuppressDriftWarning` at lines 55-65 ignores expected drift from agent/model/directory changes).
- **`cli/src/cache-drift-plugin.ts:151-172`** — `event` hook clears per-session state on `session.deleted`.

---

## 4. Hrana/SQLite server (`cli/src/hrana-server.ts`)

Kimaki embeds its own SQLite database server speaking the **Hrana v2 over HTTP** protocol (libSQL), instead of accessing the SQLite file directly from every process, so that CLI subcommands and the OpenCode plugin process can share one database.

- **`cli/src/hrana-server.ts:1-14`** — banner: "In-process HTTP server speaking the Hrana v2 protocol. Backed by the `libsql` npm package... Binds to the fixed lock port for single-instance enforcement." Links the Hrana v2 spec.
- **`cli/src/hrana-server.ts:18-24`** — imports `Database from 'libsql'`, and `createLibsqlHandler, createLibsqlNodeHandler, libsqlExecutor` from the `libsqlproxy` package (protocol implementation lives outside this repo).
- **`cli/src/hrana-server.ts:26-31`** — circular-import note: `opencode.ts → hrana-server.ts → opencode.ts`, safe because both directions only use lazy runtime calls.
- **`cli/src/hrana-server.ts:117-147`** (`startHranaServer({ dbPath, bindAll })`) — resolves `getLockPort()` (from `config.ts`), evicts any prior kimaki instance on that port (`evictExistingInstance`), opens the SQLite file with `new Database(dbPath)`, sets `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`.
- **`cli/src/hrana-server.ts:149-151`** — `const hranaFetchHandler = createLibsqlHandler(libsqlExecutor(database)); const hranaNodeHandler = createLibsqlNodeHandler(hranaFetchHandler)`.
- **`cli/src/hrana-server.ts:154-197`** (combined HTTP handler) — routes:
  - `POST /kimaki/wake` — auth-gated (`isAuthorizedRequest`), waits for `discordGatewayReady` (up to 30s) then returns `{ ready: true }` — used to gate wake-ups until Discord is connected.
  - `GET /health` — unauthenticated; returns `{ status: 'ok', pid: process.pid }`, used both for single-instance eviction and, from `opencode.ts`, for discovering a running server.
  - `GET /kimaki/opencode-port` — unauthenticated, localhost-only; returns the currently running OpenCode server's port (consumed by `discoverExistingServer` in `cli/src/opencode.ts:429-472`).
  - `/v2`, `/v2/pipeline` — the actual Hrana protocol routes, auth-gated, delegate to `hranaNodeHandler(req, res)`.
- **`cli/src/hrana-server.ts:73-90`** (`isAuthorizedRequest`) — Bearer-token auth using `crypto.timingSafeEqual` against `store.getState().gatewayToken`, relevant because the server can optionally bind `0.0.0.0` (`bindAll`) when `KIMAKI_INTERNET_REACHABLE_URL` is set.
- **`cli/src/hrana-server.ts:271-323`** (`evictExistingInstance`) — single-instance enforcement: fetches `/health` on the lock port to get the previous process's PID, sends `SIGTERM`, then polls for up to 10s to confirm it exited (no `SIGKILL`, no `lsof`/`netstat`).
- Called from **`cli/src/cli-runner.ts:1620-1623`**:
  ```ts
  const hranaResult = await startHranaServer({
    dbPath: path.join(getDataDir(), 'discord-sessions.db'),
    bindAll: getInternetReachableBaseUrl() !== null,
  })
  ```
  with the surrounding comment at `cli/src/cli-runner.ts:1616-1619` explaining it must start *before* `initDatabase()` because it is both the DB server and the single-instance lock.
- **`cli/src/opencode.ts:65`** — `getHranaUrl` is imported from `./hrana-server.js` and injected as `KIMAKI_DB_URL` into the OpenCode server's child-process env (`cli/src/opencode.ts:544`) so the injection-guard/other in-server code can reach the DB via HTTP instead of a file: path.

---

## 5. Session lifecycle (`session.create`/`get`/`messages`, `provider.list`, agent/model switching)

The primary orchestration file is **`cli/src/session-handler/thread-session-runtime.ts`** (largest single file, session lifecycle is implemented per-Discord-thread as a `ThreadSessionRuntime`-style class). Supporting logic lives in `agent-utils.ts` and `model-utils.ts` in the same directory.

### `session.create` / `session.get` (ensureSession)
- **`cli/src/session-handler/thread-session-runtime.ts:4325-4334`** — if a `sessionId` is already known for the thread (from in-memory state or DB fallback via `getThreadSession`), call:
  ```ts
  const sessionResponse = await getClient().session.get({
    sessionID: sessionId,
    directory: this.sdkDirectory,
  }).catch((e) => new OpenCodeSdkError({ operation: 'session.get', cause: e }))
  ```
- **`cli/src/session-handler/thread-session-runtime.ts:4348-4368`** — if no existing session was found/valid, builds per-session `PermissionRuleset` (base worktree-isolation deny rules + CLI `--permission` overrides) and calls:
  ```ts
  const createResult = await getClient().session.create({
    directory: this.sdkDirectory,
    permission: sessionPermissions,
  }).catch((e) => new OpenCodeSdkError({ operation: 'session.create', cause: e }))
  ```
  Title is intentionally omitted so OpenCode auto-generates a summary. On success, `setThreadSession(this.thread.id, session.id)` immediately persists the thread→session mapping to the DB (comment notes this must happen before the next external-sync poll tick).
- **`cli/src/opencode.ts:1100-1106`** — `buildSessionPermissions({ directory, originalRepoDirectory })` doc-comment: this is where the one session-level permission rule lives (worktree-origin deny), everything else must live in server config to not silently override user `opencode.json` rules.

### `session.messages`
- **`cli/src/session-handler/thread-session-runtime.ts:4525-4533`** — inside session-restore/state-sync logic, conditionally calls `client.session.messages({...})` alongside `client.provider.list({...})` (paired fetch for restoring UI state).
- **`cli/src/context-awareness-plugin.ts:329-336`** — `client.session.messages({ sessionID, directory, limit: 20 })` (see §3).
- **`cli/src/wait-session.ts:88-92`** — `getClient().session.messages({ sessionID: sessionId, directory: projectDirectory })` polled every 5s in `waitForSessionComplete` (see §1).
- **`cli/src/cli-commands/session.ts:424`** — `getClient().session.messages({...})` used by the `kimaki session` CLI subcommand.

### `session.promptAsync` / `session.command` (turn dispatch)
- **`cli/src/session-handler/thread-session-runtime.ts:3199-3220`** (`submitViaOpencodeQueue`) — builds the request object with `sessionID`, `directory`, `parts` (text + synthetic context + images), `system` (from `getOpencodeSystemMessage`), optional `agent`, `model`, then:
  ```ts
  await waitForGlobalEventListener()
  const promptResult = await getClient().session.promptAsync(request)
    .catch((e) => new OpenCodeSdkError({ operation: 'session.promptAsync', cause: e }))
  ```
  Note the explicit `await waitForGlobalEventListener()` before prompting — the global SSE listener (§ diagram below) must be connected first so no early events are dropped.
- **`cli/src/session-handler/thread-session-runtime.ts:4098`** — `getClient().session.command(...)` — dispatches slash-command-style input (accepts only `FilePart`, not text parts, per the comment at line 4044).
- **`cli/src/session-handler/thread-session-runtime.ts:4192`** — a second `getClient().session.promptAsync({...})` call site (distinct turn-submission path).
- **`cli/src/session-handler/thread-runtime-state.ts:38`** — comment: "When set, dispatches via `session.command()` instead of `session.prompt()`."

### `session.abort` / `session.status`
- **`cli/src/session-handler/thread-session-runtime.ts:3522`** — `await client.session.abort({...})` (user-triggered interrupt path in the bot process, distinct from the interrupt-plugin's own abort call at `cli/src/opencode-interrupt-plugin.ts:159` which runs inside the OpenCode server process).
- **`cli/src/cli-commands/session.ts:113, 748`** — `getClient().session.status({...})` and `client.session.abort({...})` for the `kimaki session` CLI.
- **`cli/src/task-runner.ts:427`** and **`cli/src/wait-session.ts:80`** — `session.status` polling (see §1).

### `provider.list` (model resolution)
- **`cli/src/session-handler/model-utils.ts:139-141`**:
  ```ts
  const providersResponse = await getClient().provider.list({ directory })
    .catch((e) => new OpenCodeSdkError({ operation: 'provider.list', cause: e }))
  ```
  inside `getDefaultModel`, whose doc-comment (lines 105-110) states the model-resolution priority: (1) OpenCode `config.model` project setting, (2) user's recent-models TUI state, (3) first connected provider's default model from the API.
- **`cli/src/session-handler/model-utils.ts:159-160`** — after fetching providers, also calls `getClient().config.get({ directory })` to check for a configured default model, validated against the `connected`/`all` provider lists via `isModelValid`.
- **`cli/src/session-handler/thread-session-runtime.ts:1898, 3111, 3924, 4532`** — four additional call sites of `client.provider.list({ directory: this.sdkDirectory })`, used to validate a requested `agent`/`model` override before submitting a turn.

### Agent switching
- **`cli/src/session-handler/agent-utils.ts:61-63`**:
  ```ts
  const agentsResponse = await getClient().app.agents({ directory })
    .catch((e) => new OpenCodeSdkError({ operation: 'app.agents', cause: e }))
  ```
  Resolves an `agentPreference` (from session state, or per-channel default via `getChannelAgent(channelId)`) against the live agent list; throws if an explicitly-requested agent doesn't validate.
- **`cli/src/cli-runner.ts:628-637`** (`backgroundInit`) — also calls `getClient().app.agents({ directory: currentDir })` at bot startup to populate Discord slash-command choices.
- Agent field flows into the prompt request at **`cli/src/session-handler/thread-session-runtime.ts:3213`**: `...(resolvedAgent ? { agent: resolvedAgent } : {})`.

### Model switching
- Model field flows into the same prompt request at **`cli/src/session-handler/thread-session-runtime.ts:3214`**: `...(modelField ? { model: modelField } : {})`, alongside `...variantField` (line 3215) for reasoning-effort/thinking variants.
- **`cli/src/session-handler/model-utils.ts:1-10`** doc-comment (function purpose) plus the `getDefaultModel` body (lines 118-160, above) is the canonical model-resolution path when no explicit per-message override is given.

---

## OpenCode message/session flow (text diagram)

```
Discord message in a kimaki-managed channel/thread
        │
        ▼
discord-bot.ts (discord.js MessageCreate handler)
        │  resolves ThreadSessionRuntime for the thread
        ▼
ThreadSessionRuntime.ensureSession()                         [thread-session-runtime.ts:~4300]
        │
        ├─ known sessionId? ──► session.get({sessionID, directory})     [4330]
        │                         │ found?  ──► reuse session
        │                         │ not found / no id ──┐
        │                                                ▼
        └─ session.create({directory, permission: sessionPermissions}) [4360]
                 │  (permission = buildSessionPermissions() [opencode.ts]
                 │   + parsePermissionRules(--permission flags))
                 ▼
        setThreadSession(threadId, session.id)  → SQLite (via Hrana server)
                 │
                 ▼
ThreadSessionRuntime resolves agent + model:
   agent-utils.getAgentPreference() ──► app.agents({directory})        [agent-utils.ts:61]
   model-utils.getDefaultModel()   ──► provider.list({directory})      [model-utils.ts:139]
                                    ──► config.get({directory})        [model-utils.ts:159]
                 │
                 ▼
await waitForGlobalEventListener()   (ensure SSE stream connected first)
                 │
                 ▼
submitViaOpencodeQueue():
  session.promptAsync({sessionID, directory, parts, system, agent?, model?, ...}) [3220]
     -or-
  session.command({...})  for slash-command style input                [4098]
                 │
                 ▼
   ┌─────────────────────────── OpenCode server process ───────────────────────────┐
   │                                                                                 │
   │  kimaki-opencode-plugin.ts hooks fire (all v2-client-backed):                  │
   │    contextAwarenessPlugin  'chat.message'   → inject branch/pwd/memory parts   │
   │    cacheDriftPlugin        'chat.message' +                                    │
   │                            'experimental.chat.system.transform' → diff prompt  │
   │    anthropicAuthPlugin     'chat.headers' + auth.provider.loader.fetch         │
   │                            → rewrite tool names / inject beta headers / OAuth  │
   │    opencode-interrupt-plugin 'chat.message' → schedule interrupt timer;        │
   │                              on new msg while busy: session.abort() then       │
   │                              session.promptAsync() replay                      │
   │                                                                                 │
   │  Provider API call (e.g. Anthropic) → streamed response                       │
   │  Emits SSE events on /global/event: message.updated, session.idle,            │
   │  session.deleted, ...                                                          │
   └─────────────────────────────────────────────────────────────────────────────┘
                 │
                 ▼
global-event-listener.ts: single persistent SSE connection to /global/event
   dispatchEvent() broadcasts to every registered ThreadSessionRuntime callback  [global-event-listener.ts:158-162]
                 │
                 ▼
ThreadSessionRuntime.handleEvent() filters by sessionId, updates thread state,
edits/streams the Discord message, and (on completion) triggers wait-session.ts
consumers (session.status + session.messages polling) for `kimaki send --wait`.
```

Hrana/SQLite sits underneath the whole flow: `cli/src/hrana-server.ts` starts before `initDatabase()` (`cli-runner.ts:1620-1629`) and every process (bot, CLI subcommands, and the OpenCode server's injection-guard code via `KIMAKI_DB_URL`) talks to the same SQLite file through the Hrana HTTP protocol rather than opening the file directly from multiple processes, which is also how the single-instance lock and `/kimaki/opencode-port` server-discovery endpoint are implemented.

---

## File inventory referenced in this audit

| File | Role |
|---|---|
| `cli/src/opencode.ts` | Single-server process manager, `createOpencodeClient` call site, permission config builder |
| `cli/src/opencode-command.ts` | Binary resolution + `kimaki` shim creation for OpenCode child processes (no SDK client) |
| `cli/src/wait-session.ts` | `session.status`/`session.messages` polling for `--wait` flows |
| `cli/src/task-runner.ts` | Scheduled task runner; `session.status` for concurrency checks |
| `cli/src/cli-runner.ts` | Bot startup orchestration; calls `startHranaServer`, `backgroundInit` (agent/command list) |
| `cli/src/config.ts` | `getDataDir`/`getLockPort`/etc., thin wrapper over `store.ts` |
| `cli/src/hrana-server.ts` | Embedded Hrana v2 HTTP/SQLite server, single-instance lock, `/kimaki/wake`, `/kimaki/opencode-port` |
| `cli/src/opencode-interrupt-plugin.ts` | Abort+replay plugin for queued messages during busy sessions |
| `cli/src/context-awareness-plugin.ts` | Synthetic context injection (branch/pwd/memory/tutorial) |
| `cli/src/anthropic-auth-plugin.ts` | Legacy Anthropic OAuth + Claude Code request rewriting plugin |
| `cli/src/cache-drift-plugin.ts` | System-prompt drift detector (cache-invalidation diagnostics) |
| `cli/src/kimaki-opencode-plugin.ts` | Aggregator that re-exports all in-repo plugins for the OpenCode plugin loader |
| `opencode-kimaki-plugin/src/index.ts` | Standalone `@kimaki/opencode-plugin` npm package wrapping just the Anthropic auth plugin |
| `cli/src/plugin-opencode-client.ts` | `createPluginClient`/`createPluginAppLogger` shared by all plugins |
| `cli/src/session-handler/thread-session-runtime.ts` | Per-thread session lifecycle: create/get/prompt/abort/agent&model resolution |
| `cli/src/session-handler/agent-utils.ts` | `app.agents()` based agent preference resolution |
| `cli/src/session-handler/model-utils.ts` | `provider.list()`/`config.get()` based default-model resolution |
| `cli/src/session-handler/global-event-listener.ts` | Single global SSE `/global/event` connection, fan-out to thread runtimes |
