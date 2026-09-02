---
title: Final review evidence
date: 2026-09-01
---

# Final review evidence

## Approval and sandbox live probe

Invocation:

```bash
printf '<initialize>\n<thread/start approvalPolicy=on-request sandbox=workspace-write>\n' |
  omo app-server --listen stdio://
```

Relevant response captured during final review:

```json
{
  "id": 2,
  "result": {
    "approvalPolicy": "on-request",
    "approvalsReviewer": "user",
    "sandbox": {"type": "dangerFullAccess"}
  }
}
```

Conclusion:

- `thread/start.approvalPolicy:"on-request"` is applied.
- requested `sandbox:"workspace-write"` is not applied; the runtime remains `dangerFullAccess`.
- Phase 0 must verify that command/file-change actions actually emit approval server requests before implementation proceeds.

## `turn/start` input types: wire/runtime mismatch

Installed source:

`/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/protocol/base.d.ts`

The wire `UserInput` union declares:

- `text`
- `image`
- `localImage`
- `skill`
- `mention`

Wire adapter:

`/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/turn-adapter.js`

The wire adapter accepts the same five variants.

Actual turn runtime:

`/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/threads/turn-runtime.js`

`parseInput()` currently accepts **text only** and rejects `image`, `localImage`, `skill`, and `mention` with `-32602 Invalid params`. Audio is also unsupported.

Conclusion: omomaki v1 must translate every non-text Discord input into text before `turn/start`, or first patch Senpi's turn runtime. The plan chooses bot-side text translation to avoid requiring a Senpi fork.

## Thread and turn overrides

Installed source:

- `dist/modes/app-server/protocol/thread.d.ts`
- `dist/modes/app-server/protocol/turn.d.ts`

Confirmed:

- `thread/start` supports `model`, `modelProvider`, `cwd`, `approvalPolicy`, `approvalsReviewer`, and instruction override fields in its wire type.
- `turn/start` supports `model`, `effort`, `cwd`, and `clientUserMessageId`.

Runtime behavior still requires integration tests; generated wire types alone are not treated as proof of semantic effect.

## Provider account API and failover

Installed sources:

- `dist/modes/app-server/protocol/requests.d.ts`
- `dist/modes/app-server/protocol/notifications.d.ts`
- `dist/modes/app-server/server/account.js`
- `docs/providers.md`

Confirmed request methods:

- `account/providerAccounts/read`
- `account/providerAccounts/pin`
- `account/providerAccounts/remove`

Confirmed notifications:

- `account/providerAccounts/updated`
- `account/providerAccounts/failover`

`docs/providers.md` states that sessions use account affinity and automatically fail over after rate-limit/auth failures.

## Package manager and baseline

`_refs/kimaki/package.json` declares:

```json
{"packageManager":"pnpm@9.15.9"}
```

The final plan therefore keeps pnpm, Vitest, and TypeScript rather than introducing Bun as the project-level runner.

## Source baseline and license

- kimaki SHA: `e0ba496af5fb29ac2076b97eda42573bb1e988ed`
- License: MIT
- `cli/package.json` has workspace dependencies on multiple in-repo packages and submodules; the executable baseline must use the full monorepo, not a `cli/` extraction.
