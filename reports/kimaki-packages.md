# Kimaki Monorepo Package Inventory

> Source ref: `/home/whrho/git/omomaki/_refs/kimaki` (pnpm workspace)
> Generated: 2026-09-01

## 1. pnpm Workspace Package List

**File:** `/home/whrho/git/omomaki/_refs/kimaki/pnpm-workspace.yaml`

```yaml
packages:
  - ./*
  - ./traforo/website
  - '!./subrouter'
  - ./subrouter/cli
  - ./subrouter/opencode
```

**Resolution:**

| Glob | Resolves to | Present on disk |
|------|-------------|-----------------|
| `./*` | Every immediate child directory with a `package.json` | Yes — 14 packages found (see §2) |
| `./traforo/website` | Nested website inside `traforo` | No — `/home/whrho/git/omomaki/_refs/kimaki/traforo` does not exist on this checkout |
| `!./subrouter` | Excludes the private root of the `subrouter` workspace | `/home/whrho/git/omomaki/_refs/kimaki/subrouter` does not exist on this checkout |
| `./subrouter/cli` | Published `@subrouter/cli` package inside subrouter | Not present (subrouter not checked out) |
| `./subrouter/opencode` | Published `@subrouter/opencode` package inside subrouter | Not present (subrouter not checked out) |

**Effective workspace members on this checkout** (directories under `/*` containing `package.json`):

```
cli
db
discord-digital-twin
discord-slack-bridge
fly-admin
inference-proxy
kimaki-demo
libsqlproxy
opencode-cached-provider
opencode-deterministic-provider
opencode-kimaki-plugin
sigillo
slack-digital-twin
website
```
Plus the workspace root itself (`/home/whrho/git/omomaki/_refs/kimaki/package.json`, name `root`).

**Root package manager:** `pnpm@9.15.9` — declared in `/home/whrho/git/omomaki/_refs/kimaki/package.json` (`packageManager` field).

**Root `prepare` script** (`/home/whrho/git/omomaki/_refs/kimaki/package.json`):

```
pnpm -r --filter errore --filter libsqlproxy --filter opencode-injection-guard --filter traforo --filter fly-admin --filter profano --filter sigillo --filter discord-slack-bridge --filter @subrouter/cli --filter @subrouter/opencode run build
```

Note: Several filters (`errore`, `opencode-injection-guard`, `traforo`, `profano`) reference packages not present on this checkout — they are expected to be git submodules or unpublished workspace members.

---

## 2. Package Table

Sources: `package.json` at root and each `*/package.json`. Key deps = `dependencies` (first ~8); devDeps omitted unless notable. Build script = `scripts.build` (or equivalent).

| Package Dir | Name | Version | Role | Key Deps | Build Script |
|-------------|------|---------|------|----------|--------------|
| `.` (root) | `root` | — (private) | Workspace orchestrator; `prepare` builds publishable packages, `test`/`dev`/`kimaki` delegate to `kimaki` filter | `dependencies: @opencode-ai/sdk, string-dedent, tiny-jsonc` · `devDependencies: oxfmt, prettier, tsx, typescript, vite, vite-node, vitest` | `prepare: pnpm -r --filter ... run build` (see §1) |
| `cli` | `kimaki` | `0.26.0` | **Main Discord bot CLI** — Discord bot (`discord.js`), OpenCode integration, worktrees, voice, session/queue handling. Bin entry for `npx kimaki`. | `@ai-sdk/google, @ai-sdk/openai, @ai-sdk/provider, @discordjs/voice, @google/genai, @libsql/client, @opencode-ai/plugin, @opencode-ai/sdk, discord.js, drizzle-orm, libsql, errore (workspace), libsqlproxy (workspace), discord-digital-twin (workspace)` | `rm -rf dist && pnpm generate && pnpm tsc` (`scripts.build` in `/home/whrho/git/omomaki/_refs/kimaki/cli/package.json`) · `generate: pnpm generate:sql` → `tsx scripts/generate-schema-sql.ts` |
| `db` | `db` | `0.0.0` (private) | **Shared DB package** — Prisma schema + dual-runtime client factories (Node vs Cloudflare workerd). See §3. | `@prisma/adapter-pg, @prisma/client, pg` · `dev: prisma` | No `build`; `gen: prisma generate && pnpm tsc` · `postinstall: prisma generate` |
| `discord-digital-twin` | `discord-digital-twin` | `0.1.1` | **Test harness** — Local Discord API twin for testing `discord.js` bots without hitting real Discord. Provides in-memory twin + Prisma/sqlite schema. See §5. | `@libsql/client, @prisma/adapter-libsql, @prisma/client, discord-api-types, spiceflow, ws` | `tsc` (`scripts.build`) |
| `discord-slack-bridge` | `discord-slack-bridge` | `0.1.0` | **Platform adapter** — `discord.js`-to-Slack adapter; lets any `discord.js` bot control a Slack workspace without code changes. | `@slack/web-api, db (workspace), discord-api-types, spiceflow, ws` | `tsc` |
| `fly-admin` | `@fly.io/sdk` | `0.1.2` | **Infra SDK** — TypeScript client for Fly Machines REST + GraphQL APIs. Vendored fork of `supabase/fly-admin` with native fetch, exec, releaseLease, metadata. | `errore (workspace)` (peer) | `tsc` |
| `inference-proxy` | `inference-proxy` | `0.0.1` (private) | **Cloudflare Worker** — OpenAI-compatible inference proxy for Kimaki Pro, deployed at `openai.kimaki.dev`. | `eventsource-parser, pg` | No `build`; `dev: wrangler dev`, `deploy: wrangler deploy` (via `/home/whrho/git/omomaki/_refs/kimaki/inference-proxy/package.json`) |
| `kimaki-demo` | `kimaki-demo` | `0.0.0` (private) | **Demo deployment** — Fly.io deployment config for the Kimaki demo Discord server (`fly.json`, `Dockerfile`). No code. | — | — (no scripts) |
| `libsqlproxy` | `libsqlproxy` | `0.1.0` | **Hrana proxy** — Runtime-agnostic Hrana v2 HTTP server for SQLite; exposes any SQLite DB (Cloudflare DO, libsql, better-sqlite3) via libSQL remote protocol. | — (runtime-agnostic) | `rm -rf dist *.tsbuildinfo && tsc` |
| `opencode-cached-provider` | `opencode-cached-provider` | `0.0.1` (private) | **AI provider** — Caching wrapper for OpenCode providers; uses `@libsql/client` + `spiceflow` + `eventsource-parser`. | `@libsql/client, errore (workspace), eventsource-parser, spiceflow` | No `build`; `typecheck: tsc --noEmit`, `test: vitest --run` |
| `opencode-deterministic-provider` | `opencode-deterministic-provider` | `0.0.1` (private) | **AI provider** — Deterministic provider implementing `@ai-sdk/provider` for reproducible tests. | `@ai-sdk/provider` | No `build`; `typecheck: tsc --noEmit`, `test: vitest --run` |
| `opencode-kimaki-plugin` | `@kimaki/opencode-plugin` | `0.1.0` | **OpenCode plugin** — Claude Pro/Max subscription support via Anthropic OAuth for OpenCode. Depends on `kimaki` workspace. | `kimaki (workspace)` | `tsc` |
| `sigillo` | `sigillo` | `0.0.1` | **Secrets management** — Secrets and environment variable management CLI (`bin: dist/cli.js`). | — | `rm -rf dist *.tsbuildinfo && tsc && chmod +x dist/cli.js` |
| `slack-digital-twin` | `slack-digital-twin` | `0.1.0` | **Test harness** — Local Slack API twin for testing Slack bots without hitting real Slack. Mirrors `discord-digital-twin` pattern for Slack. | `@libsql/client, @prisma/adapter-libsql, @prisma/client, spiceflow` | `tsc` |
| `website` | `website` | `0.0.0` (private) | **Cloudflare Worker + Vite site** — Marketing/docs + auth (better-auth), uses `db` + `discord-slack-bridge`. | `@holocron.so/vite, @slack/web-api, better-auth, db (workspace), discord-slack-bridge (workspace), spiceflow, zod, react` | `vite build` (`scripts.build` in `/home/whrho/git/omomaki/_refs/kimaki/website/package.json`) — also `tsc --noEmit` pre-check in `deployment` scripts |

**Additional notes:**

- `/home/whrho/git/omomaki/_refs/kimaki/cli/package.json` declares `bin: bin.js` and `exports` for `./anthropic-auth-plugin` (`dist/anthropic-auth-plugin.js`).
- `/home/whrho/git/omomaki/_refs/kimaki/sigillo/package.json` declares `bin: dist/cli.js`.
- Packages `errore`, `gateway-proxy`, `traforo`, `subrouter`, `opencode-injection-guard`, `usecomputer`, `slop` are listed in `pnpm-workspace.yaml` or root `prepare` but have no `package.json` on this checkout (likely git submodules / external workspaces).

---

## 3. Shared DB Package Role

**Package:** `/home/whrho/git/omomaki/_refs/kimaki/db/package.json` (name `db`, `0.0.0`, private, `type: module`)

**Schema:** `/home/whrho/git/omomaki/_refs/kimaki/db/schema.prisma`

- **Provider:** `postgresql` (`datasource db { provider = "postgresql" }`).
- **Dual Prisma generators:**
  - `client_node` — `provider = "prisma-client"`, `output = "src/generated/node"`, `moduleFormat = "esm"`, `runtime = "nodejs"` — for Node consumers (`cli`, scripts).
  - `client_cloudflare` — `provider = "prisma-client"`, `output = "src/generated/cloudflare"`, `moduleFormat = "esm"`, `runtime = "workerd"`, `compilerBuild = "small"` (~900 KiB WASM vs ~3.6 MiB `fast`; critical for CF Worker cold starts) — for `website` and `inference-proxy`.
- **Runtime factories:**
  - `/home/whrho/git/omomaki/_refs/kimaki/db/src/prisma-node.ts` — `createPrisma(connectionString?)` using `pg.Pool` + `PrismaPg` adapter + `PrismaClient` from `src/generated/node/client.js`.
  - `/home/whrho/git/omomaki/_refs/kimaki/db/src/prisma-cloudflare.ts` — workerd-targeted factory (conditional export via `exports["./src"].workerd` in `package.json`).
  - Exports map in `/home/whrho/git/omomaki/_refs/kimaki/db/package.json` routes `workerd` condition to `prisma-cloudflare.ts`, default to `prisma-node.ts`.
- **better-auth core tables** (required by `better-auth`, lowercase via `@@map`):
  - `User` (`@@map("user")`) — `id, name, email @unique, emailVerified, image?, createdAt, updatedAt`, relations `accounts, sessions, gatewayClients`.
  - `Session` (`@@map("session")`) — `id, expiresAt, token @unique, createdAt, updatedAt, ipAddress?, userAgent?, userId → User`.
  - `Account` (`@@map("account")`) — OAuth accounts `id, accountId, providerId, userId → User, accessToken?, refreshToken?, idToken?, accessTokenExpiresAt?, refreshTokenExpiresAt?, scope?, password?, createdAt, updatedAt`.
  - `Verification` (`@@map("verification")`) — `id, identifier, value, expiresAt, createdAt?, updatedAt?`.
- **`gateway_clients` table** (PlanetScale / Postgres — canonical source of truth for gateway auth/routing):
  - **File:** `/home/whrho/git/omomaki/_refs/kimaki/db/schema.prisma` (`model gateway_clients`)
  - **Comment:** "Matches the gateway-proxy's raw SQL schema in `db_config.rs`. The Rust proxy uses raw SQL (`CREATE TABLE IF NOT EXISTS`), Prisma manages the same table via `db push` for the website. Slack bridge also reuses this table: `guild_id` stores Discord guild IDs in Discord mode and Slack team IDs in Slack mode. Website KV cache mirrors selected row fields for short-TTL auth/routing acceleration, but this table remains canonical."
  - **Columns:**
    | Column | Type | Notes |
    |--------|------|-------|
    | `client_id` | `String` | Kimaki client ID; identifies the kimaki user connecting to the gateway. Part of `@@id([client_id, guild_id])`. |
    | `secret` | `String` | Secret for authorizing gateway clients. |
    | `guild_id` | `String` | Guild/team the client installed (Discord guild ID or Slack team ID). Part of `@@id([client_id, guild_id])`. |
    | `platform` | `gateway_client_platform` (`discord` \| `slack`) `@default(discord)` | Platform discriminator. |
    | `bot_token` | `String?` | Slack workspace bot token; `null` for Discord rows. |
    | `reachable_url` | `String?` | When set, gateway-proxy connects outbound to `reachable_url/gateway` WS instead of awaiting inbound. |
    | `created_at` | `DateTime @default(now()) @db.Timestamptz` | Creation timestamp. |
    | `updated_at` | `DateTime? @default(now()) @db.Timestamptz` | Update timestamp. |
    | `user_id` | `String?` → `User?` (`onDelete: Cascade`) | Optional FK to `User`. |
  - **PK:** `@@id([client_id, guild_id])` (composite).
  - **Consumers:** `cli` (via `db` workspace dep), `website` (auth/routing + KV cache), `discord-slack-bridge` (reuses `guild_id` for team IDs), `inference-proxy` (direct `pg` access), Rust `gateway-proxy` (raw SQL).

---

## 4. TypeScript Setup

**Base config:** `/home/whrho/git/omomaki/_refs/kimaki/tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowJs": false,
    "composite": true,
    "outDir": "${configDir}/dist",
    "rootDir": "${configDir}/src",
    "lib": ["es2022", "es2017", "es7", "es6", "dom"],
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "strict": true,
    "esModuleInterop": true,
    "noImplicitAny": false,
    "useUnknownInCatchVariables": false,
    "sourceMap": true,
    "jsx": "react-jsx",
    "skipLibCheck": true
  },
  "exclude": ["**/node_modules", "**/.*/"]
}
```

Note: No `tsconfig.json` at repository root — only `tsconfig.base.json` is shared.

**Per-package tsconfigs:**

| Package | File | Extends / Style | Key Differences |
|---------|------|-----------------|-----------------|
| `db` | `/home/whrho/git/omomaki/_refs/kimaki/db/tsconfig.json` | `extends: ../tsconfig.base.json` | `outDir: dist`, `rootDir: src`, `noEmit: true` (typecheck only; Prisma generates JS). |
| `cli` | `/home/whrho/git/omomaki/_refs/kimaki/cli/tsconfig.json` | Standalone `nodenext` (does NOT extend base) | `target: ESNext`, `module: nodenext`, `moduleResolution: nodenext`, `verbatimModuleSyntax: true`, `allowJs: true`, `jsx: react-jsx`. Strictest local flags (`noUncheckedIndexedAccess`, etc.). |
| `discord-digital-twin` | `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/tsconfig.json` | Standalone `nodenext` | Same `nodenext` pattern as `cli`; `declaration` + `declarationMap` + `sourceMap`. |
| `discord-slack-bridge` | `/home/whrho/git/omomaki/_refs/kimaki/discord-slack-bridge/tsconfig.json` | Standalone `nodenext` | Identical to `discord-digital-twin`. |
| `slack-digital-twin` | `/home/whrho/git/omomaki/_refs/kimaki/slack-digital-twin/tsconfig.json` | Standalone `nodenext` | Same as above plus `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`. |
| `fly-admin` | `/home/whrho/git/omomaki/_refs/kimaki/fly-admin/tsconfig.json` | Standalone `nodenext` | Minimal: `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `declaration` true. |
| `libsqlproxy` | `/home/whrho/git/omomaki/_refs/kimaki/libsqlproxy/tsconfig.json` | Standalone `nodenext` | Same minimal `nodenext` + `exclude: src/**/*.test.ts`. |
| `opencode-kimaki-plugin` | `/home/whrho/git/omomaki/_refs/kimaki/opencode-kimaki-plugin/tsconfig.json` | Standalone `nodenext` | Same minimal `nodenext`. |
| `sigillo` | `/home/whrho/git/omomaki/_refs/kimaki/sigillo/tsconfig.json` | Standalone `nodenext` | Same minimal `nodenext`. |
| `opencode-cached-provider` | `/home/whrho/git/omomaki/_refs/kimaki/opencode-cached-provider/tsconfig.json` | Standalone `nodenext` (typecheck only) | `noEmit: true`, `verbatimModuleSyntax: true`. |
| `opencode-deterministic-provider` | `/home/whrho/git/omomaki/_refs/kimaki/opencode-deterministic-provider/tsconfig.json` | Standalone `nodenext` (typecheck only) | Same `noEmit: true` pattern. |
| `inference-proxy` | `/home/whrho/git/omomaki/_refs/kimaki/inference-proxy/tsconfig.json` | Standalone `bundler` (typecheck only) | `module: ESNext`, `moduleResolution: bundler`, `noEmit: true`, `noImplicitAny: false`. |
| `website` | `/home/whrho/git/omomaki/_refs/kimaki/website/tsconfig.json` | Standalone `bundler` (typecheck only) | `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `types: [@cloudflare/workers-types, vite/client]`, `jsx: react-jsx`, `isolatedModules: true`, `noEmit: true`. |

**Summary:** Only `db` extends `tsconfig.base.json`. All other packages use standalone `nodenext` (Node libraries) or `bundler` (Workers/Vite) configs. The base is effectively a template for `db`-like packages; real build configs are per-package.

---

## 5. Test Harness (Vitest, discord-digital-twin)

**Vitest — global:**

- Declared in `/home/whrho/git/omomaki/_refs/kimaki/package.json` (`devDependencies: vitest ^3.2.4`) and as a root script: `"test": "NODE_ENV=test pnpm --filter kimaki run vitest"`.
- Individual packages declare `vitest` locally: `cli` (via root `vitest`), `discord-digital-twin`, `discord-slack-bridge`, `libsqlproxy`, `opencode-cached-provider`, `opencode-deterministic-provider`, `slack-digital-twin`.

**Vitest — `cli` config:** `/home/whrho/git/omomaki/_refs/kimaki/cli/vitest.config.ts`

- `testTimeout: 8_000`, `hookTimeout: 5_000`.
- `env: { KIMAKI_VITEST: "1" }` — `config.ts` and `db.ts` auto-isolate from real `~/.kimaki/` DB and running Hrana server when this flag is set.
- `pool: "forks"`, `poolOptions.forks.maxForks: 1` — single fork for deterministic CI; `forks` (not `threads`) so e2e suites that mutate `process.env` (`KIMAKI_DB_URL`, `KIMAKI_LOCK_PORT`, etc.) do not race. Single fork also keeps per-worker OpenCode external servers isolated.
- CPU profiling via `VITEST_CPU_PROF=1` → `--cpu-prof` with output to `tmp/cpu-profiles/`.
- `cli` is the primary e2e surface: ~30 `*.e2e.test.ts` files (e.g., `gateway-proxy.e2e.test.ts`, `thread-message-queue.e2e.test.ts`, `queue-advanced-*.e2e.test.ts`) plus unit tests (`*.test.ts`).

**`discord-digital-twin` — role:**

- **File:** `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/package.json` (name `discord-digital-twin`, `0.1.1`)
- **Description:** "Local Discord API twin for testing discord.js bots without hitting real Discord servers".
- **Key files:** `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/src/index.ts` (main entry), `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/schema.prisma` (Prisma/SQLite schema for twin state), `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/src/schema.sql` (generated SQL).
- **Scripts:** `generate` → `prisma generate && pnpm generate:sql`; `generate:sql` → ephemeral SQLite `dev.db` + `prisma db push` + `sqlite3 .schema` capture; `build: tsc`; `test: vitest`.
- **Exports:** `".": dist/index.js`, `"./src": src/index.ts`, `"./src/*": src/*.ts`, `"./schema.prisma": schema.prisma`.
- **Consumers:** `cli` depends on it (`"discord-digital-twin": "workspace:^"` in `/home/whrho/git/omomaki/_refs/kimaki/cli/package.json` — used in e2e tests via `test-utils.ts` and `queue-advanced-e2e-setup.ts`); `discord-slack-bridge` lists it as `devDependency`.
- **Sibling:** `slack-digital-twin` (`/home/whrho/git/omomaki/_refs/kimaki/slack-digital-twin/package.json`) mirrors the same pattern for Slack (`@slack/web-api`, `spiceflow`, Prisma/sqlite), used by `discord-slack-bridge` e2e.

**Other test-adjacent packages:**

- `opencode-cached-provider` / `opencode-deterministic-provider` — `test: vitest --run` (single-run mode).
- `slack-digital-twin` — `test: vitest` (same harness as `discord-digital-twin`).

---

## 6. CLI Bin Entry

**Package:** `/home/whrho/git/omomaki/_refs/kimaki/cli/package.json` (`kimaki@0.26.0`)

- **Bin field:** `"bin": "bin.js"` — points to `/home/whrho/git/omomaki/_refs/kimaki/cli/bin.js`.
- **Bin shim — `/home/whrho/git/omomaki/_refs/kimaki/cli/bin.js`:**

  ```js
  #!/usr/bin/env node
  import './dist/bin.js'
  ```

  Minimal ESM re-export; `dist/bin.js` is the compiled output of `src/bin.ts`.

- **Source entry — `/home/whrho/git/omomaki/_refs/kimaki/cli/src/bin.ts`:**
  Respawn wrapper for the bot process. When running the default command (no subcommand) with `--auto-restart`, spawns `cli.js` as a child and restarts on non-zero exits (crash/OOM). Subcommands (`send`, `tunnel`, `project`, etc.) run directly without the wrapper. Respects `__KIMAKI_CHILD` (child process) and `EXIT_NO_RESTART=64` (intentional exit). Injects V8 flags `--heapsnapshot-near-heap-limit=3` and `--diagnostic-dir` for OOM heap snapshots; `heap-monitor.ts` polling at 85% remains the early-warning path.

- **Build chain:** `pnpm build` (`rm -rf dist && pnpm generate && pnpm tsc`) → `generate:sql` → `tsc` emits `dist/bin.js` (and `dist/cli.js` + all `src/*.js`). `prepublishOnly` runs `sync-skills` then `build`.

- **Published files** (`files` field): `dist`, `src`, `skills`, `bin.js`.

- **Sibling bin:** `sigillo` (`/home/whrho/git/omomaki/_refs/kimaki/sigillo/package.json`) has `bin: dist/cli.js` (built via `tsc && chmod +x dist/cli.js`).

---

## File Path Index

| Path | Purpose |
|------|---------|
| `/home/whrho/git/omomaki/_refs/kimaki/pnpm-workspace.yaml` | Workspace globs |
| `/home/whrho/git/omomaki/_refs/kimaki/package.json` | Root orchestrator |
| `/home/whrho/git/omomaki/_refs/kimaki/tsconfig.base.json` | Shared TS base |
| `/home/whrho/git/omomaki/_refs/kimaki/cli/package.json` | Main `kimaki` CLI |
| `/home/whrho/git/omomaki/_refs/kimaki/cli/bin.js` | Bin shim |
| `/home/whrho/git/omomaki/_refs/kimaki/cli/src/bin.ts` | Respawn wrapper source |
| `/home/whrho/git/omomaki/_refs/kimaki/cli/tsconfig.json` | CLI TS config |
| `/home/whrho/git/omomaki/_refs/kimaki/cli/vitest.config.ts` | Vitest config |
| `/home/whrho/git/omomaki/_refs/kimaki/db/package.json` | Shared DB package |
| `/home/whrho/git/omomaki/_refs/kimaki/db/schema.prisma` | Prisma schema (better-auth + gateway_clients) |
| `/home/whrho/git/omomaki/_refs/kimaki/db/src/prisma-node.ts` | Node Prisma factory |
| `/home/whrho/git/omomaki/_refs/kimaki/db/src/prisma-cloudflare.ts` | Workerd Prisma factory |
| `/home/whrho/git/omomaki/_refs/kimaki/db/tsconfig.json` | DB TS config (extends base) |
| `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/package.json` | Discord twin harness |
| `/home/whrho/git/omomaki/_refs/kimaki/discord-digital-twin/tsconfig.json` | Twin TS config |
| `/home/whrho/git/omomaki/_refs/kimaki/slack-digital-twin/package.json` | Slack twin harness |
| `/home/whrho/git/omomaki/_refs/kimaki/website/package.json` | Website (Vite + Worker) |
| `/home/whrho/git/omomaki/_refs/kimaki/website/tsconfig.json` | Website TS config |
