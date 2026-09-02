# omomaki Phase 0 baseline record

## Git import

- Resolved SHA: `e0ba496af5fb29ac2076b97eda42573bb1e988ed`
- Branch: `omomaki-phase0` (checked out at the SHA, working tree clean of upstream modifications)
- Remote: `upstream-kimaki` -> https://github.com/remorses/kimaki.git
- History: full clone, 2367 commits (git rev-list --count HEAD)
- Untracked additions at root (intentional, outside upstream tree): `PLAN.md`, `reports/`, `_refs/`, `.omo/` (harness state)

## Submodules (git submodule status)

- `errore` 45866e977eae5b03fe72a10f5c9892946b5f6208 (errore@0.14.1-9-g45866e9)
- `traforo` 16657a82ac06a4b515c61eec7f820ff5842e7e0d (traforo@0.7.2-10-g4fdac51)
- `opencode-injection-guard` 5acc3ae2cd5ebbcc4152c6681884cdaf8125dbbe (opencode-injection-guard@0.2.1-2-g5acc3ae)
- `subrouter` 028dd1be3a65a374e742f48898090045077d2a00 (@subrouter/cli@0.5.0-2-g47f3138)
- `gateway-proxy`: NOT initialized (excluded per PLAN.md Phase 0-2 non-goal)

## Toolchain

- pnpm 9.15.9 (matches `packageManager: pnpm@9.15.9`); corepack prepared
- Node v24.14.0

## Verification steps

| Step | Command | Exit | Notes |
|---|---|---|---|
| install | `pnpm install --frozen-lockfile` (repo root) | 0 | 12.8s; prepare script built workspace packages (subrouter/opencode, discord-slack-bridge, db prisma client 등) |
| baseline typecheck | `cd cli && pnpm tsc` | 0 | 0 errors |
| baseline smoke tests | `cd cli && pnpm test -- --run src/db.test.ts src/cli-parsing.test.ts` | 0 | 2 files, 16 tests passed |

## Deviations / environment notes (recorded, not code changes)

1. `discord-digital-twin` must be generated + built BEFORE `cli` typecheck resolves its types:
   `pnpm --filter discord-digital-twin generate` (prisma generate + generate:sql, sqlite3 present) then
   `pnpm --filter discord-digital-twin build`. Without it, `cli pnpm tsc` reports 10 pre-existing
   TS errors in `../discord-digital-twin/src/*` (implicit-any + missing generated client).
2. `pnpm test --run <file>` fails on this toolchain (pnpm: Unknown option 'run'). The working forms are
   `pnpm test -- --run <file>` and `pnpm exec vitest run <file>`. Downstream Phase 0 verification uses these forms;
   PLAN.md command blocks should be read with this substitution.
3. Git import note: the checkout was repaired once (broken partial clone from an interrupted DAG lane was
   removed and re-cloned); final state verified against the pinned SHA and full history.

## Verdict

BASELINE OK

## Gate check by baseline-verify lane

Re-ran the three cheap checks independently on 2026-09-02:

1. `cd /home/whrho/git/omomaki/cli && pnpm tsc` -> exit code 0 (no output, no errors).
2. `cd /home/whrho/git/omomaki/cli && pnpm exec vitest run src/db.test.ts src/cli-parsing.test.ts` ->
   ```
    RUN  v3.2.6 /home/whrho/git/omomaki/cli

    ✓ src/cli-parsing.test.ts (11 tests) 341ms
    ✓ src/db.test.ts (5 tests) 329ms

    Test Files  2 passed (2)
         Tests  16 passed (16)
   ```
3. `git -C /home/whrho/git/omomaki rev-parse HEAD` -> `e0ba496af5fb29ac2076b97eda42573bb1e988ed`
   `git -C /home/whrho/git/omomaki branch --show-current` -> `omomaki-phase0`

All three match the recorded baseline. Gate: PASS.
