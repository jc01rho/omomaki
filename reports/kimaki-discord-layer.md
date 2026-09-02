# Kimaki Discord Orchestration Layer — Audit

Source root: `/home/whrho/git/omomaki/_refs/kimaki` (all paths below are relative to this root unless noted).
Audit date: 2026-09-02. Read-only audit; no code was written.

> **Note on scope gap**: `gateway-proxy/` is a git submodule (see `.gitmodules:12-15`, pointing to
> `https://github.com/remorses/gateway-proxy.git` branch `multi-client-support`) that is **not checked out**
> in this working copy — the directory is empty (verified via `find gateway-proxy -type f`, zero results;
> `git submodule status` shows a `-` prefix meaning "not initialized"). Section 5 is therefore reconstructed
> from every reference to the gateway proxy inside the `cli/` package that *is* checked out, plus the
> project's own architecture doc at `website/src/docs/docs/reference/gateway-architecture.mdx`, which is
> read-only documentation, not proxy source. No claim below cites gateway-proxy/*.rs source because none
> exists locally.

## Table of key files (LOC via `wc -l`)

| File | LOC | Role |
|---|---:|---|
| `cli/src/discord-bot.ts` | 1713 | Discord client creation, gateway event handlers, message pipeline, thread lifecycle |
| `cli/src/cli.ts` | 421 | goke CLI entrypoint, top-level flags, wires subcommand groups |
| `cli/src/cli-runner.ts` | ~2000 (read to 1958+) | `run()` bootstrap: hrana server, DB init, credential resolution, Discord login, channel setup wizard |
| `cli/src/discord-command-registration.ts` | 686 | Builds and PUTs the Discord slash-command list (static + dynamic agent/user/skill commands) |
| `cli/src/channel-management.ts` | 415 | Channel=project mapping: category/channel creation, default "kimaki" channel bootstrap |
| `cli/src/database.ts` | 1231 | Drizzle query layer over local SQLite (thread/session/channel/model/task state) |
| `cli/src/schema.ts` | ~380 (read to 250+) | Drizzle table definitions mirrored from `schema.sql` |
| `cli/src/db.ts` | 213 | libSQL/Hrana client init, schema migration runner, WAL pragmas |
| `cli/src/discord-utils.ts` | 918 | Permission checks, markdown splitting, thread messaging, file uploads |
| `cli/src/discord-urls.ts` | 88 | Configurable Discord REST/gateway base URLs (self-hosted vs gateway-proxy) |
| `cli/src/interaction-handler.ts` | ~626+ | Slash-command/interaction dispatch table |
| `cli/src/commands/*.ts` (49 files) | 15150 total | One file per slash command / interaction handler |
| `db/schema.prisma` | 120 | Postgres schema for the **website/gateway control plane** (better-auth + `gateway_clients`), not the bot's local SQLite |
| `gateway-proxy/` | 0 (empty, uninitialized submodule) | Rust multi-tenant Discord gateway proxy — source not present locally |

---

## 1. Bot bootstrap & event loop

**Entry point.** `cli/src/cli.ts:1-40` defines the `goke('kimaki')` CLI (`cli.ts:38`) with the default `''` command
that runs the bot (`cli.ts:40-96` for flags, action body starts `cli.ts:145`). It builds an `options` object from
flags (`--data-dir`, `--gateway`, `--use-worktrees`, `--allow-mention`, `--enable-skill`, etc., `cli.ts:44-131`),
validates them (e.g. permission-timeout bounds `cli.ts:255-266`, skill whitelist/blacklist mutual exclusion
`cli.ts:213-221`), stores them via `store.setState(...)` (`cli.ts:296-311`), and finally calls
`run({ restartOnboarding, addChannels, dataDir, useWorktrees, enableVoiceChannels, gateway, gatewayCallbackUrl })`
at `cli.ts:392-401`. `cli.ts:413-420` wires the other subcommand groups (`botCommands`, `sendCommands`,
`taskCommands`, `projectCommands`, `userCommands`, `sessionCommands`, `maintenanceCommands`) and calls
`cli.parse()` at `cli.ts:421`.

**`run()` bootstrap sequence** lives in `cli/src/cli-runner.ts:1569` onward:
- `startCaffeinate()` (`cli-runner.ts:1577`) then ensures `opencode`/`bun` binaries exist in parallel
  (`cli-runner.ts:1582-1601`).
- Starts the in-process Hrana SQLite server *before* DB init — `cli-runner.ts:1609-1615` explains this is both
  the DB server and the single-instance lock (binds a fixed lock port); `initDatabase()` is called at
  `cli-runner.ts:1618`.
- Resolves bot credentials (self-hosted token vs gateway `client_id:secret`) via `resolveCredentials(...)`
  (`cli-runner.ts:1620-1624`, function defined at `cli-runner.ts:1234`).
- In gateway mode, rewrites `store.discordBaseUrl` to `KIMAKI_GATEWAY_PROXY_REST_BASE_URL`
  (`cli-runner.ts:1651-1653`) so REST calls route through the proxy instead of `discord.com` directly.
- Starts the OpenCode server non-blocking (`cli-runner.ts:1663-1677`) in parallel with Discord login.
- Creates the Discord client with `createDiscordClient()` and logs in inside a `Promise` that resolves on
  `Events.ClientReady` or rejects on `Events.Error` (`cli-runner.ts:1734-1769`); `discordClient.login(token)`
  is the actual gateway connect call (`cli-runner.ts:1769`).
- After login, starts IPC polling (`cli-runner.ts:1772`, `startIpcPolling`) and registers `process.on('exit', stopIpcPolling)`.

**Client construction and intents.** `createDiscordClient()` in `discord-bot.ts:287-306` builds a `discord.js`
`Client` with `GatewayIntentBits.Guilds | GuildMessages | MessageContent | GuildVoiceStates`
(`discord-bot.ts:294-299`) and `partials: [Channel, Message, User, ThreadMember]` (`discord-bot.ts:300-305`); the
REST `api` base and `allowedMentions.parse` are pulled from the centralized `store` so gateway mode can override
them (`discord-bot.ts:289-291`, `discord-bot.ts:305`).

**Event loop registration.** `startDiscordBot()` (`discord-bot.ts:309` onward) attaches all gateway event
handlers before login:
- `Events.ClientReady` (`discord-bot.ts:379`) — logs guild count, fetches `application.id` if not provided
  (`discord-bot.ts:333-341`), calls `markDiscordGatewayReady()` (`discord-bot.ts:344`), then
  `registerInteractionHandler(...)` and `registerVoiceStateHandler(...)` (`discord-bot.ts:353-354`) and starts
  `startExternalOpencodeSessionSync(...)` (`discord-bot.ts:355`).
- `Events.Error` / `Events.ShardError` / `Events.ShardDisconnect` / `Events.ShardReconnecting` /
  `Events.ShardResume` / `Events.ShardReady` / `Events.Invalidated` (`discord-bot.ts:388-475`) — a shard-state
  map (`shardReconnectState`, `discord-bot.ts:63-72`) tracks the last error/close code per shard so the
  reconnecting log line has context; `describeCloseCode()` (`discord-bot.ts:27-49`) documents that gateway-proxy
  redeploys cause raw TCP drops (WS close code 1006) that discord.js treats as a reconnect.
- `Events.MessageCreate` (`discord-bot.ts:476`) — the core message pipeline, see Section 3.
- `Events.MessageUpdate` (`discord-bot.ts:1118`), `Events.MessageDelete` (`discord-bot.ts:1190`),
  `Events.ThreadCreate` (`discord-bot.ts:1218`, auto-start threads — see Section 2),
  `Events.ThreadDelete` (`discord-bot.ts:1473`), `Events.ChannelDelete` (`discord-bot.ts:1480`).
- Final `discordClient.login(token)` at `discord-bot.ts:1511` inside `startDiscordBot` itself (used by callers
  that don't pre-create/login the client via `cli-runner.ts`).

**Shutdown resilience.** The file header comment (`discord-bot.ts:1-9`) documents that during self-restart
(gateway reconnect limit, SIGUSR2) discord.js can fire late errors from pending async ops after client
destruction; a global `shuttingDown` flag (declared `discord-bot.ts:11-14`) is checked by an
`uncaughtException` handler and `removeAllListeners()` is called before `client.destroy()`.

**Slash command registration wiring.** `discord-command-registration.ts` is explicitly split out of `cli.ts` to
avoid a circular import chain `cli → discord-bot → interaction-handler → command → cli`
(`discord-command-registration.ts:1-4`). It's called both at startup and by
`cli/src/commands/restart-opencode-server.ts` for post-restart re-registration (same header comment).

---

## 2. Channel = project / Thread = session mapping

**Core model:** one Discord **text channel** maps 1:1 to a filesystem **project directory**; one Discord
**thread** inside that channel maps 1:1 to an OpenCode **session**. Both mappings are persisted in the local
SQLite DB (Section 4), not in Discord channel topics.

**Channel → project directory:**
- `setChannelDirectory` / `getChannelDirectory` / `findChannelsByDirectory` / `listTrackedTextChannels` are
  imported from `./database.js` into `channel-management.ts:15-20`.
- `createProjectChannels({ guild, projectDirectory, ... })` (`channel-management.ts:128-186`) creates a
  `ChannelType.GuildText` channel under the "Kimaki" category (`channel-management.ts:143-148`), immediately
  persists the mapping with `setChannelDirectory({ channelId: textChannel.id, directory: projectDirectory,
  channelType: 'text' })` (`channel-management.ts:150-154`), and optionally creates a paired voice channel with
  its own `setChannelDirectory(..., channelType: 'voice')` call (`channel-management.ts:169-179`) when
  `enableVoiceChannels` is set.
- `ensureKimakiCategory` / `ensureKimakiAudioCategory` (`channel-management.ts:69-121`) find-or-create the
  parent categories, naming them `Kimaki` / `Kimaki Audio` or `Kimaki {botName}` / `Kimaki Audio {botName}` for
  non-default bot names.
- `getChannelsWithDescriptions(guild)` (`channel-management.ts:196-217`) lists all `GuildText` channels in the
  guild and attaches `kimakiDirectory` from `getChannelDirectory(channel.id)` — used by `discord-bot.ts:361-373`
  at startup to log which channels are configured for this bot.
- `createDefaultKimakiChannel(...)` (`channel-management.ts:243` onward) creates a general-purpose
  `#kimaki`/`#kimaki-{botName}` channel bound to `getDefaultKimakiDirectory()`
  (`<projectsDir>/kimaki`, `channel-management.ts:225-227`), git-inits that directory
  (`channel-management.ts:352-361`), and is idempotent: it checks `findChannelsByDirectory(...)`
  (`channel-management.ts:270-273`) before creating, including a guild-scoped "tombstone" check
  (`channel-management.ts:284-292`) so a manually-deleted default channel is not recreated, and a
  by-name fallback scan (`channel-management.ts:296-313`) that deliberately refuses to adopt a same-named
  channel owned by a different DB (different machine).

**Thread → session:**
- `Events.ThreadCreate` handler (`discord-bot.ts:1218-1298+`) only proceeds for `newlyCreated` threads whose
  parent is a `GuildText` channel (`discord-bot.ts:1222-1227`), fetches the starter message
  (`discord-bot.ts:1229-1239`), and parses a YAML marker embedded in the starter message's embed footer via
  `parseEmbedFooterMarker<ThreadStartMarker>` (`discord-bot.ts:1247-1249`, helper defined
  `discord-bot.ts:76-91`) — only trusting markers whose author is the bot itself
  (`discord-bot.ts:1252-1254`, "prevent crafted embeds"). If `marker.start` is true, it resolves the parent
  channel's project directory via `getChannelDirectory(parent.id)` (`discord-bot.ts:1284`) and starts a session
  in that thread.
- The binding itself is written by `setThreadSession(threadId, sessionId)` / `upsertThreadSession(...)` in
  `database.ts:816-833` — a thin wrapper that always sets `source: 'kimaki'` and writes an explicit `updated_at`
  (comment at `database.ts:826-830` explains why: the SQLite column default format and JS `Date` ISO format
  don't sort against each other, so `updated_at` must always be written explicitly for
  `getThreadIdBySessionId`'s ordering to be correct).
- `getThreadSession(threadId)` (`database.ts:811-814`) is the forward lookup (thread → session).
- `getThreadIdBySessionId(sessionId)` (`database.ts:868-880`) is the reverse lookup; its docstring
  (`database.ts:860-867`) explains `session_id` is *not* unique in `thread_sessions` because `/resume` can bind
  one session to a new thread without clearing the old row, so the reverse lookup orders by most recent
  `updated_at`/`created_at` to avoid targeting a dead thread.
- Per-thread working directory (plain checkout vs git worktree vs other workspace) is tracked separately via
  `thread_workspaces` / `thread_worktrees`; `getThreadWorktreeOrWorkspace` is a re-export alias for
  `getThreadWorkspace` (`database.ts:765`, `export const getThreadWorktreeOrWorkspace = getThreadWorkspace`),
  imported into `discord-bot.ts:24` and used e.g. by `cli/src/commands/session.ts:14` when starting a
  new session inside an existing thread so it inherits the thread's worktree/workspace directory
  (`commands/session.ts:1-3`, `commands/session.ts:53-60`).
- Multi-machine routing guard: before responding to any message, `discord-bot.ts:582-604` resolves the
  "owning" channel (parent channel for threads, the channel itself otherwise) and silently drops the message if
  `getChannelDirectory(owningChannelId)` returns nothing (`discord-bot.ts:598-604`), so a second kimaki instance
  pointed at the same guild but a different local DB won't respond to channels it doesn't own.

---

## 3. Slash commands & message handling

**Slash command definitions.** `registerCommands({ token, appId, guildIds, userCommands, agents })`
(`discord-command-registration.ts:70-79`) builds a static array of `SlashCommandBuilder`s — `resume`
(`:83-95`), `new-session` (`:96-124`), `new-worktree` (`:125-...`), and (per grep) `undo`, `redo`, `verbosity`,
`restart-opencode-server`, `run-shell-command`, `context-usage`, `session-id`, `upgrade-and-restart`,
`transcription-key`, `mcp`, `screenshare`, `vscode` (`discord-command-registration.ts:389-467`), each capped to
a 100-char description via `truncateCommandDescription()` (`discord-command-registration.ts:59-62`) and marked
`setDMPermission(false)`. After the static list, dynamic commands are appended in priority order — agent quick
commands first (`discord-command-registration.ts:475-509`, suffixed `-agent`, sanitized via
`sanitizeAgentName`), then user-config/MCP-prompt/skill commands sorted `config < mcp < skill`
(`discord-command-registration.ts:511-524`), filtered through `isSkillAllowed(...)` for
`--enable-skill`/`--disable-skill` (`discord-command-registration.ts:527-529`), because the whole set is later
sliced to Discord's 100-command cap (comment `discord-command-registration.ts:470-473`).

**Interaction dispatch.** `cli/src/interaction-handler.ts` imports one or more handler functions from nearly
every file in `cli/src/commands/` (import block `interaction-handler.ts:9-115`) — e.g.
`handleSessionCommand`/`handleSessionAutocomplete` from `commands/session.ts`
(`interaction-handler.ts:11-14`), `handleResumeCommand`/`handleResumeAutocomplete` from `commands/resume.ts`
(`interaction-handler.ts:27-30`), `handleModelCommand`/`handleProviderSelectMenu`/`handleModelSelectMenu` from
`commands/model.ts` (`interaction-handler.ts:52-57`), permission-button handling from `commands/permissions.ts`
(`interaction-handler.ts:42`), and voice-adjacent `handleScreenshareCommand` / `handleVscodeCommand`
(`interaction-handler.ts:107-108`). `registerInteractionHandler` (referenced from `discord-bot.ts:353`,
imported `discord-bot.ts:91`) is the function that subscribes this dispatch table to `Events.InteractionCreate`
and enforces `hasKimakiAdminPermission`/`hasKimakiBotPermission` (imported `interaction-handler.ts:116`) plus
channel-directory gating via `getChannelDirectory` (`interaction-handler.ts:119`).

**One command file per feature**, 49 files under `cli/src/commands/` totaling 15,150 lines
(`wc -l cli/src/commands/*.ts`), e.g.: `session.ts` (new/resume session start), `worktrees.ts` (769 lines,
largest — git worktree lifecycle), `vscode.ts` (378 lines, VNC/VS Code tunnel), `agent.ts` (agent quick-command
generation, used by `discord-command-registration.ts:19-22`), `permissions.ts`, `ask-question.ts`,
`file-upload.ts`, `action-buttons.ts`, `model.ts`/`model-variant.ts`, `queue.ts`, `undo-redo.ts`,
`fork.ts`/`fork-subagent.ts`, `btw.ts`, `merge-worktree.ts`, `new-worktree.ts`, `mcp.ts`, `login.ts`,
`gemini-apikey.ts`.

**Message handling pipeline** (`discord-bot.ts:476-616+`, `Events.MessageCreate`):
1. Detects CLI-injected prompts (bot posting its own message with a YAML marker in the embed footer) via
   `isSelfBotMessage`/`isCliInjectedPrompt` (`discord-bot.ts:479-492`) and, if so, extracts
   `sessionStartSource`, `cliInjectedUsername/UserId/Agent/Model/Permissions/InjectionGuardPatterns/ParentSessionId`
   from the marker (`discord-bot.ts:493-510`).
2. Ignores the bot's own non-injected messages to avoid role-assignment loops (`discord-bot.ts:512-515`,
   comment explains why).
3. For other bots' messages, requires `hasKimakiBotPermission` via `resolveGuildMessageMember`
   (`discord-bot.ts:521-527`, both imported from `discord-utils.ts`).
4. Ignores messages that start with a mention of a different user in text channels
   (`discord-bot.ts:530-535`, `discord-bot.ts:561-563`) to avoid interrupting user-to-user chat.
5. Fetches partial messages if needed (`discord-bot.ts:539-548`).
6. Enforces per-channel "mention mode" (`getChannelMentionMode`, `discord-bot.ts:567-577`) — bot only responds
   when @mentioned or the message is a `!`-prefixed shell command.
7. Multi-machine channel-ownership gate (`discord-bot.ts:582-604`, described in Section 2).
8. Role gating: `resolveGuildMessageMember` + `hasNoKimakiRole` (`discord-bot.ts:607-616+`) blocks users with an
   explicit "no-kimaki" role.

**Discord utility layer** (`cli/src/discord-utils.ts`, 918 lines) exports: permission checks
`hasKimakiBotPermission` (`:42`), `hasKimakiAdminPermission` (`:75`), `resolveGuildMessageMember` (`:99`),
`hasNoKimakiRole` (`:147`); thread helpers `reactToThread` (`:160`), `archiveThread` (`:215`),
`ensureThreadMember` (`:296`); text helpers `stripMentions` (`:316`), `escapeBackticksInCodeBlocks` (`:329`),
`splitMarkdownForDiscord` (`:355`, handles Discord's 2000-char message limit),
`escapeDiscordFormatting` (`:720`); messaging `sendThreadMessage` (`:613`),
`SILENT_MESSAGE_FLAGS`/`NOTIFY_MESSAGE_FLAGS` (`:325,327`); directory resolution
`getKimakiMetadata` (`:724`), `resolveProjectDirectoryFromAutocomplete` (`:751`),
`resolveWorkingDirectory` (`:801`); and file I/O `uploadFilesToDiscord` (`:854`,
`DISCORD_DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024` at `:844`).

**URL indirection** (`cli/src/discord-urls.ts`, 88 lines) centralizes every Discord endpoint the bot calls so
gateway mode can transparently redirect them: `getDiscordRestBaseUrl()` reads `store.getState().discordBaseUrl`
(`:19-21`); `getDiscordRestApiUrl()` appends `/api` (`:27-29`); `discordApiUrl(path)` builds full REST v10 URLs
for raw `fetch()` calls (`:47-49`); `createDiscordRest(token)` builds a `discord.js` `REST` client pointed at
the configured base (`:56-58`); `getGatewayProxyRestBaseUrl({ gatewayUrl })` swaps `wss→https`/`ws→http` to
derive the REST base from the WS gateway-proxy URL (`:76-88`), used at `cli-runner.ts:90-92` to compute
`KIMAKI_GATEWAY_PROXY_REST_BASE_URL`.

---

## 4. SQLite local state

**Storage location & engine.** `database.ts:1-3` states the DB is Drizzle-ORM-managed SQLite at
`<dataDir>/discord-sessions.db`. `cli/src/db.ts` is the actual client: `getDbUrl()` (`db.ts:53-59`) defaults to
`file:<dataDir>/discord-sessions.db` unless `KIMAKI_DB_URL` is set (Hrana HTTP mode, used by plugin subprocess),
and `initializeDb()` (`db.ts:70-107`) opens it via `@libsql/client` + `drizzle-orm/libsql`, sets
`PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000` in file mode (`db.ts:92-93`), then runs
`migrateSchema(...)`.

**Schema bootstrap/migration** (`db.ts:113-197`): reads `cli/src/schema.sql` and executes each `CREATE TABLE`
statement (`db.ts:117-141`), then applies a hardcoded list of idempotent `ALTER TABLE ... ADD COLUMN`
statements for forward-compatible column additions (`db.ts:150-164`, e.g. `bot_mode`, `client_id`,
`client_secret`, `guild_id` on `channel_directories`), then a set of one-off `UPDATE` data migrations
(`db.ts:167-179`, e.g. renaming `tools-and-text` → `tools_and_text` verbosity values, rewriting the legacy
`discord-gateway.kimaki.xyz` proxy host to `.dev`), then migrates legacy `thread_worktrees` rows into
`thread_workspaces` (`db.ts:182-193`), then backfills missing `client_id`/`client_secret` on `bot_tokens` rows
(`db.ts:195-207`).

**Drizzle table definitions** (`cli/src/schema.ts`) mirror `schema.sql` and include (with line numbers from
the read excerpt): `thread_sessions` (`:28-40`, PK `thread_id`, columns `session_id`, `source` enum
`kimaki|external_poll`, `parent_session_id`, `updated_at` w/ `$onUpdate`), `session_events` (`:42-51`,
append-only event log keyed by `session_id`/`thread_id` with composite indexes), `part_messages` (`:53-58`),
`bot_tokens` (`:60-69`, includes `bot_mode` enum `self_hosted|gateway`, `client_id`/`client_secret`/`proxy_url`
for gateway mode), `channel_directories` (`:71-79`, the channel→project mapping table used throughout Section
2, PK `channel_id`, `channel_type` enum `text|voice`, `guild_id`), `bot_api_keys` (`:81-87`),
`thread_worktrees` (`:89-97`, legacy, superseded by) `thread_workspaces` (`:99-109`), `channel_models`
(`:111-117`), `session_models` (`:119-124`), `channel_agents` (`:126-131`), `session_agents` (`:133-137`),
`channel_worktrees` (`:139-144`), `channel_verbosity` (`:146-150`), `channel_mention_mode` (`:152-158`),
`global_models` (`:160-166`), `scheduled_tasks` (`:168-190`, cron/at scheduler with status enum
`planned|running|completed|cancelled|failed`), `scheduled_task_runs` (`:192-204`), `session_start_sources`
(`:206-214`), `forum_sync_configs` (`:216-226`), `session_sleeps` (`:228-244`+, durable wake-later state for
the `kimaki_sleep` tool, with an at-least-once/at-most-once delivery diagram in the comment block
`:220-232`).

**Query layer** (`cli/src/database.ts`, 1231 lines) wraps every table in typed async functions, all obtained
via `const db = await getDb()`. Representative groups: scheduled tasks (`createScheduledTask` `:57-93`,
`listScheduledTasks` `:95-105`, `claimScheduledTaskRunning` `:174-183`); session sleeps
(`upsertSessionSleep` `:371`, `getDueSessionSleeps` `:415`, `consumeSessionSleepWake` `:503`); model/agent
preference cascades (`getChannelModel`/`setChannelModel` `:550,556`, `getVariantCascade` `:603`); worktree
state (`getThreadWorktree` `:643`, `createPendingWorktree` `:648`, `setWorktreeReady` `:663`); channel
config (`getChannelWorktreesEnabled`/`setChannelWorktreesEnabled` `:793,798`, `getChannelDirectory` `:805-809`);
and thread/session mapping (`getThreadSession` `:811`, `setThreadSession` `:816`, `upsertThreadSession` `:820`,
`getThreadParentSessionId` `:844`, `getThreadIdBySessionId` `:868`, `getAllThreadSessionIds` `:882`) — all
detailed in Section 2.

**Relationship to `db/schema.prisma`:** this Postgres schema (120 lines, `db/schema.prisma:1-17` shows dual
Prisma generators for Node and Cloudflare Workers runtimes) is **not** the bot's local state store — it is the
website/control-plane schema: better-auth tables `User`/`Session`/`Account`/`Verification`
(`schema.prisma:29-79`) plus the single Kimaki-specific table `gateway_clients`
(`schema.prisma:96-111`, composite PK `[client_id, guild_id]`, columns `secret`, `guild_id`, `platform` enum
`discord|slack`, `bot_token` (Slack only), `reachable_url` for the gateway-proxy to dial outbound). The comment
at `schema.prisma:88-95` states this Prisma model is deliberately kept in sync with a *raw SQL* table the Rust
gateway-proxy manages itself (`db_config.rs`, not present locally — see Section 5 scope note), and that the
Discord/Slack bridges and website KV cache all read/write this same table as the source of truth for which
kimaki client owns which guild.

---

## 5. gateway-proxy multi-tenant path

**Source availability.** `_refs/kimaki/gateway-proxy/` is a registered git submodule
(`.gitmodules:12-15`: `path = gateway-proxy`, `url = https://github.com/remorses/gateway-proxy.git`,
`branch = multi-client-support`) that has not been initialized/cloned in this checkout — the directory contains
zero files (`find gateway-proxy -type f` → empty) and `git submodule status` prefixes it with `-` (uninitialized).
**No gateway-proxy/*.rs files could be read for this audit.** Everything below is reconstructed from (a) the
project's own architecture doc, and (b) every call site in `cli/` that talks to or configures the proxy.

**Purpose (per `website/src/docs/docs/reference/gateway-architecture.mdx:9`):** gateway mode lets multiple users
share one Discord bot application instead of each self-hosting their own bot; a Rust proxy sits between Discord
and every kimaki CLI instance, routing events per-client by guild authorization
(`gateway-architecture.mdx:1-9`).

**Multi-tenant routing model** (`gateway-architecture.mdx:11-38`): the proxy's shards receive all Discord
gateway events and broadcast each to every connected client, but each client only receives events for guilds it
is authorized for; authorization is read from a `gateway_clients` table in Postgres, polled every second
(`gateway-architecture.mdx:23`) — this is the same table modeled in `db/schema.prisma:96-111` (Section 4).
Events without a `guild_id` (DMs, user updates) are dropped for multi-tenant clients
(`gateway-architecture.mdx:37`).

**Offline buffering** (`gateway-architecture.mdx:40-58`): the proxy buffers `MESSAGE_CREATE`, `MESSAGE_UPDATE`,
`MESSAGE_DELETE`, `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE` per disconnected client in a 200-event FIFO,
in-memory only (lost on proxy redeploy) (`gateway-architecture.mdx:53-56`, summary table
`gateway-architecture.mdx:126-131`). On reconnect it replays: (1) a synthetic `READY` scoped to the client's
authorized guilds plus `GUILD_CREATE` per guild, (2) the buffered events in order, (3) the live broadcast
stream (`gateway-architecture.mdx:63-84`).

**CLI-side integration points** (all in the checked-out `cli/` package):
- `cli/src/discord-urls.ts:76-88` — `getGatewayProxyRestBaseUrl({ gatewayUrl })` derives the REST base by
  swapping `wss:`/`ws:` to `https:`/`http:`, i.e. the proxy serves both the WS gateway endpoint and a REST proxy
  on the same host.
- `cli/src/cli-runner.ts:88-92` — hardcodes `KIMAKI_GATEWAY_PROXY_URL` default `wss://discord-gateway.kimaki.dev`
  (overridable via env) and computes `KIMAKI_GATEWAY_PROXY_REST_BASE_URL` from it via the helper above.
- `cli/src/cli-runner.ts:1651-1653` — when `isGatewayMode`, `store.setState({ discordBaseUrl:
  KIMAKI_GATEWAY_PROXY_REST_BASE_URL })` so all subsequent REST/WS traffic (via `discord-urls.ts`) is routed
  through the proxy instead of `discord.com`.
- `cli/src/schema.ts:60-69` — local `bot_tokens` table stores `bot_mode` (`self_hosted|gateway`),
  `client_id`/`client_secret` (the credentials this CLI instance authenticates to the proxy with — matching the
  Postgres `gateway_clients.client_id`/`secret` pair in `schema.prisma:99-100`), and `proxy_url`.
- `cli/src/db.ts:158` — a data migration specifically rewrites stored gateway proxy hostnames from the old
  `discord-gateway.kimaki.xyz` to `discord-gateway.kimaki.dev`, confirming the proxy has been redeployed under a
  new domain at least once.
- `cli/src/discord-urls.ts:61-69` — `getInternetReachableBaseUrl()` reads `KIMAKI_INTERNET_REACHABLE_URL`; when
  set, the local hrana server exposes a `/kimaki/wake` endpoint (comment `discord-urls.ts:62-65`) so the
  gateway-proxy can wake a sleeping/scaled-to-zero kimaki instance and wait for it to reconnect — this is the
  `reachable_url` column referenced in `schema.prisma:101`.
- `discord-bot.ts:27-49` (`describeCloseCode`) — documents WS close code 1006 specifically as the signature of a
  gateway-proxy redeploy dropping the TCP connection without a close frame, which the CLI's shard-reconnect
  logging (`discord-bot.ts:392-461`) is tuned to recognize.
- Sibling packages also speak the same proxy protocol from the checked-out repo (outside strict CLI scope but
  confirming the shared design): `discord-slack-bridge/src/gateway.ts` and
  `discord-slack-bridge/src/gateway-session-manager.ts` (present, not read in depth for this CLI-focused audit),
  and `discord-digital-twin/src/gateway.ts` under the in-scope `discord-digital-twin/` directory.
- Local end-to-end tests exercise the wire protocol against a real or fake proxy without needing the proxy's
  own source: `cli/src/gateway-proxy.e2e.test.ts`, `cli/src/gateway-proxy-reconnect.e2e.test.ts`, and
  `cli/scripts/test-gateway-programmatic.ts` (files present, not opened in depth here — flagged as the next
  place to look for wire-level proxy behavior if `gateway-proxy/` submodule is later initialized).

**Conclusion for Section 5:** the multi-tenant behavior itself (Rust-side shard fan-out, per-guild
authorization enforcement, the 200-event FIFO buffer, synthetic READY construction) is implemented entirely in
`gateway-proxy/`, which is unavailable in this checkout. Everything the CLI does is *client-side*: point its
REST/WS URLs at the proxy, store proxy credentials locally, and treat proxy disconnects/redeploys as ordinary
shard reconnects — verified from the CLI call sites above. To audit the actual multi-tenant routing logic, the
submodule must first be initialized (`git submodule update --init gateway-proxy`).
