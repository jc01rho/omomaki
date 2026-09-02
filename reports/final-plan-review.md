---
title: Final PLAN.md review
date: 2026-09-01
verdict: PASS
---

# omomaki final plan review

## Overall verdict

**PASS — Phase 0 implementation may proceed.**

## Independent review gates

| Review area | Verdict | Key result |
|---|---|---|
| Goal and constraint completeness | PASS | Scope, baseline, parity gaps, agent/skill mapping, queue and interrupt decisions are explicit |
| QA and executable gates | PASS | pnpm/Vitest/TypeScript consistent; Phase commands are post-deliverable and reference valid existing test names |
| Architecture | PASS | initialize/reconnect, state ownership, durable queue, migration, auth and ambiguous-send contracts are decision-complete |
| Security | PASS | stdio default, mandatory on-request approval gate, path/shell/upload authz, credential storage and WS auth are explicit |
| Source/context accuracy | PASS | SHA, license, submodules, protocol/runtime mismatch, provider-account APIs and Discord limits verified locally |

## Important corrections made during final review

1. Kept the full kimaki monorepo and pnpm toolchain instead of extracting `cli/` or switching to Bun.
2. Preserved the existing SQLite/Hrana DB/lock path rather than rewriting persistence during the runtime port.
3. Added the mandatory app-server `initialize` and reconnect/resume FSM.
4. Replaced `turn/steer` queue/replay ambiguity with a durable SQLite queue and fresh `turn/start`.
5. Documented the wire/runtime input mismatch: the wire declares five input variants, but current runtime accepts text only.
6. Added text translation for image/skill/mention and transcription for audio.
7. Added `approvalPolicy:"on-request"` as a Phase 0 hard gate while acknowledging `dangerFullAccess` sandbox.
8. Added explicit shell, upload, project-root, Discord custom-id and nonce security contracts.
9. Reused Senpi provider OAuth and provider-account failover instead of storing provider tokens in the bot.
10. Added separate `omo_thread_bindings` and `omo_message_queue` tables without overwriting legacy session mappings.
11. Changed post-restart ambiguous sends to `uncertain` instead of claiming impossible exactly-once replay.

## Non-blocking residual risks

- Current omo sandbox remains `dangerFullAccess`; Phase 0 must prove command/file-change approval requests really fire.
- Direct non-text app-server input requires a future Senpi runtime fix; v1 uses text translation.
- Agent-specific tool allow/deny is not available through the current app-server and remains an explicit parity gap.
- Process-restart ambiguous sends require user-confirmed retry because JSONL reconstruction loses `clientUserMessageId`.
- Gateway multi-tenancy, realtime voice and full OpenCode-session conversion remain optional later work.

## Gate

Do not begin Phase 1 unless the Phase 0 approval roundtrip and existing kimaki baseline test suite pass.
