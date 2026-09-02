# Phase 1 live RPC evidence

Date: 2026-09-02. Worktree `/home/whrho/git/omomaki-wt-p1`.
Binary: `omo 5.0.0-0.beta.32 (engine: senpi 2026.9.2)`.

## Commands (isolated TMPDIR, no `--listen`)

Classic process stdio (NOT `--listen stdio://`, which on 2026.9.2 enables multi-session and returns `missing_session_id`).

```
omo --mode rpc --session <tmp>/sessions/p1.jsonl --session-dir <tmp>/sessions --no-extensions -e cli/src/omo-bridge/omomaki-approve.ts
```

cwd = isolated project. Injection is `--no-extensions -e <in-repo omomaki-approve.ts>` only.

## Happy path (C1)

Prompt: `Reply with the exact token RPC-OK-ONLY and nothing else. Do not use tools.`

Captured from `/tmp/omomaki-p1-rpc-classic2/prompt.json`:

- `deltas`: `RPC-OK-ONLY`
- `hasSettled`: true
- `hasToken`: true

Unit tests (RED first: missing `rpc-client.ts` / `rpc-jsonl.ts` / `omomaki-approve.ts`):

```
cd cli && pnpm tsc                 # exit 0
pnpm exec vitest run src/omo-bridge src/omo-input-translation.test.ts src/omo-schema.test.ts
# 9 files, 81 tests, exit 0
```

## Deny path (C2)

Prompt asked bash to create `/tmp/omomaki-p1-rpc-classic2/deny/should-not-exist`.
Client answered `extension_ui_response { confirmed: false }` for confirm id `b3eb3127-2081-4b62-ad2a-1845ac77ca06`.

- `denyExists`: false
- `test ! -e .../should-not-exist` → DENY_ABSENT
- `ls ~/.omo/agent/extensions` before and after identical:
  `diff.js, files.js, herdr-agent-state.test.mjs, herdr-agent-state.ts, prompt-url-widget.js, tps.js`

## Notes

- `--listen` on this omo version starts multi-session. OmoRpcClient rejects any `--listen` and uses process stdio.
- Live assistant text arrives as `message_update.assistantMessageEvent.text_delta`; the client also synthesizes a `text_delta` event for callers.
