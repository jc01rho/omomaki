# omomaki Phase 0 evidence — verification wave

Date: 2026-09-02. Commands run from repo root and `cli/` as noted. All commands were executed and captured by the orchestrator (not agent-claimed). Context: Phase 0 was superseded mid-run by the RPC-mode transition (user request); the app-server integration gates (7-8) were replaced by the R0/R1 RPC live-probe program documented in `reports/rpc-r0-r1-evidence.md`. Commands 1-6 below ran against the landed Phase 0 baseline + bridge code.

| # | Command | Exit | Verdict | Evidence tail |
|---|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` (root) | 0 | PASS | lockfile satisfied; prepare scripts OK |
| 2 | `pnpm tsc` (cli) | 0 | PASS | 0 type errors |
| 3 | `pnpm exec vitest run src/omo-bridge` | 0 | PASS | 23 tests passed (client, adapters, approvals, project-paths) |
| 4 | `pnpm exec vitest run src/omo-input-translation.test.ts` | 0 | PASS | wire/runtime contract tests green |
| 5 | `pnpm exec vitest run src/omo-schema.test.ts` | 0 | PASS | 3 omo_ tables round-trip + UNIQUE constraints |
| 6 | `pnpm exec vitest run src/thread-message-queue.e2e.test.ts` | 1 → 0 | PASS (after re-run) | 1 flaky snapshot failure on bursty case (timing, `partDelaysMs` 0/500/0/0/0); solo re-run green. No omomaki code touches queue sources (`git status` clean for those files). Recorded as flaky, not a regression. |
| 7 | app-server smoke + security-audit | — | SUPERSEDED | Replaced by R0/R1 RPC probes: `reports/rpc-r0-r1-evidence.md` (approval roundtrip PROVEN live via omomaki extension → `extension_ui_request` → `confirmed:false` → tool blocked, file not created) |
| 8 | app-server approval e2e | — | SUPERSEDED | Same as 7; PLAN.md switched to RPC transport (v2) |

## Security gate status

- Phase 0's original gate (app-server approval roundtrip) never executed as scripted; instead the RPC-mode equivalent was proven end-to-end live (see above). **No approval roundtrip was fabricated.** The gate evidence is the recorded roundtrip transcript path in the R0/R1 report.
- `PROJECT_ROOTS` canonicalization + `..`/symlink/absolute checks: unit-tested (pass).
- stdio-only invariant: enforced in `OmoRpcClient` (non-stdio listen args rejected at construction).

## Overall

**PHASE0-PASS** — commands 1-6 green (6 after one flaky-retry), 7-8 superseded by the RPC transition with equivalent-or-stronger security-gate evidence recorded.

Phase 1 (Discord integration on the RPC transport) is unblocked.
