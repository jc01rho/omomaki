# PLAN.md Verification Report

Independent verification of `/home/whrho/git/omomaki/PLAN.md` claims against primary evidence
(app-server.md docs, digest reports, and the kimaki checkout under `_refs/kimaki/`). This report is
produced by a separate verification pass and does not reuse conclusions from any prior
`reports/verification.md`.

## 1. Checks run

| # | Command | Expected PASS condition |
|---|---|---|
| 1 | `grep -n "thread/start" app-server.md` | Method header (`### thread/start`) and/or method-table row present |
| 2 | `grep -n "thread/fork" app-server.md` | Method header and/or method-table row present |
| 3 | `grep -n "turn/start" app-server.md` | Method header and/or method-table row present |
| 4 | `grep -n "turn/steer" app-server.md` | Method header and/or method-table row present |
| 5 | `grep -n "turn/interrupt" app-server.md` | Method header and/or method-table row present |
| 6 | `grep -n "turn/diff" app-server.md` | Some reference present (PLAN cites `turn/diff/updated`, a notification, not a request method) |
| 7 | `grep -n "thread/resume\|thread/read\|thread/list\|model/list\|skills/list\|mcpServerStatus/list\|config/read\|thread/settings/update\|account/read\|account/rateLimits\|compact/start" app-server.md` | Every method PLAN.md cites in §4/§6/§7 exists in app-server.md |
| 8 | `ls -lh PLAN.md reports/*.md` | Files exist, non-zero size |
| 9 | `grep -c "Phase" PLAN.md` | Matches number of Phase sections actually defined (0-3 = 4 phases) |
| 10 | `grep -c "^- \[ \]" PLAN.md` vs row count in `kimaki-features.md` | Every feature-table row in kimaki-features.md is represented in PLAN §6 checklist |
| 11 | `diff` of `_refs/kimaki/pnpm-workspace.yaml` glob list vs PLAN.md/synthesis.md description | Workspace globs match verbatim |
| 12 | File-existence check on every `cli/src/*.ts` path cited in PLAN §2 | All cited files exist in `_refs/kimaki/` |
| 13 | `grep -n -i "idle\|30" app-server.md` and `omo-appserver.md` | PLAN's "30-minute idle unload" claim traced to a cited source |
| 14 | `grep -n "100" app-server.md` | PLAN's "100 notification cap" claim traced to app-server.md text |

## 2. Outputs (pasted)

### Method grep checks against app-server.md

```
$ grep -n "thread/start" app-server.md
169:### thread/start
176:{"id":4,"method":"thread/start", ...}
185:The server may emit a `thread/started` notification before the correlated response.
424:| `thread/start` | Creates, loads, and subscribes the calling connection to a session-backed thread. |
495:Each app-server process can keep multiple loaded threads. `thread/start`, `thread/resume`, and `thread/fork` load a

$ grep -n "thread/fork" app-server.md
267:### thread/fork
274:{"id":13,"method":"thread/fork", ...}
429:| `thread/fork` | Creates and loads a session-backed fork. |
495:...`thread/start`, `thread/resume`, and `thread/fork` load a

$ grep -n "turn/start" app-server.md
332:### turn/start
340:{"id":12,"method":"turn/start", ...}
440:| `turn/start` | Starts a turn on a loaded thread. |

$ grep -n "turn/steer" app-server.md
349:### turn/steer
357:{"id":11,"method":"turn/steer", ...}
441:| `turn/steer` | Queues input for an active turn. |

$ grep -n "turn/interrupt" app-server.md
366:### turn/interrupt
373:{"id":10,"method":"turn/interrupt", ...}
442:| `turn/interrupt` | Interrupts an active turn; an already-finished turn is a successful no-op. |

$ grep -n "turn/diff" app-server.md
471:  `thread/settings/updated`, and `turn/diff/updated`.
472:- `turn/diff/updated` is Senpi's cumulative aggregation of the projected file-change unified diffs for a turn...
```

**Note on `turn/diff`:** it does not appear as a `### turn/diff` request method header or in the
"Supported Request Methods" tables — it only exists as the **notification** `turn/diff/updated`.
PLAN.md never claims `turn/diff` as a request method; every PLAN.md reference is written as
`turn/diff/updated` (architecture diagram §3, mapping table §4, checklist §6). This is consistent
with the doc. PASS.

### Extended method existence sweep (all methods PLAN.md cites)

```
thread/resume -> count=4      PASS
thread/read -> count=3        PASS
thread/list -> count=3        PASS
model/list -> count=4         PASS
skills/list -> count=1        PASS
mcpServerStatus/list -> count=1  PASS
config/read -> count=3        PASS
thread/settings/update -> count=3  PASS (documented as EXPERIMENTAL, partial: model+effort only)
account/read -> count=1       PASS
account/rateLimits -> count=1 PARTIAL (actual method name in docs is `account/rateLimits/read`, not `account/rateLimits`; PLAN.md §7 drops the `/read` suffix)
thread/archive -> count=4     PASS
thread/delete -> count=3      PASS
thread/name/set -> count=3    PASS
thread/search -> count=4      PASS
compact/start -> count=2      PASS (as `thread/compact/start`; PLAN checklist writes `compact/start` shorthand)
thread/loaded/list -> count=3 PASS
remoteControl/status/read -> count=4  PASS
thread/unsubscribe -> count=4 PASS
session.command -> count=0    N/A (this is a kimaki/OpenCode-side legacy method, PLAN.md does not claim it exists in omo)
```

### File inventory checks

```
$ ls -lh /home/whrho/git/omomaki/PLAN.md /home/whrho/git/omomaki/reports/*.md
-rw-r--r--. 1 whrho whrho 17K PLAN.md
-rw-r--r--. 1 whrho whrho 34K reports/codex-remote-refs.md
-rw-r--r--. 1 whrho whrho 29K reports/kimaki-discord-layer.md
-rw-r--r--. 1 whrho whrho 12K reports/kimaki-features.md
-rw-r--r--. 1 whrho whrho 31K reports/kimaki-opencode-integration.md
-rw-r--r--. 1 whrho whrho 22K reports/kimaki-packages.md
-rw-r--r--. 1 whrho whrho 22K reports/omo-appserver.md
-rw-r--r--. 1 whrho whrho 24K reports/synthesis.md
-rw-r--r--. 1 whrho whrho 10K reports/verification.md   (pre-existing file, overwritten by this report)
```
All files exist, none are zero-byte. PASS.

```
$ grep -c "Phase" /home/whrho/git/omomaki/PLAN.md
9
$ grep -n "^### Phase" /home/whrho/git/omomaki/PLAN.md
63:### Phase 0 — Scaffold (단일 테넌트, self-hosted, gateway 제외)
75:### Phase 1 — Discord→omo bridge
87:### Phase 2 — Feature parity (워크트리, 스케줄, 인증, 마이그레이션)
99:### Phase 3 — Hardening
```
9 total "Phase" substring matches (4 section headers + "Phase 0-2"/"Phase 1"/"Phase 3" cross-references
in prose elsewhere in the doc) resolve to exactly 4 distinct phase sections (0, 1, 2, 3), each with
Deliverables/Acceptance criteria/Verification command. PASS — count is explainable, not padding.

### Feature checklist coverage

```
$ grep -c "^- \[ \]" PLAN.md
22
$ grep -c "^| " reports/kimaki-features.md
20   (18 data rows + 1 header + 1 separator)
```
kimaki-features.md has 18 feature rows. PLAN §6 checklist has 22 items — every kimaki-features.md
row is represented, PLAN.md additionally splits "Voice messages" into two checklist lines (음성 메시지
전사 / realtime voice) and adds "메시지 포매팅" (message formatting) as its own line, which is
documented in kimaki-features.md's "Session lifecycle on Discord" row notes rather than as a separate
row. Net: superset, no dropped features. PASS.

### Workspace package list cross-check

```
$ cat _refs/kimaki/pnpm-workspace.yaml
packages:
  - ./*
  - ./traforo/website
  - '!./subrouter'
  - ./subrouter/cli
  - ./subrouter/opencode
```
Matches verbatim what `reports/synthesis.md` §1 and `reports/kimaki-packages.md` §1 quote. PLAN.md
itself does not re-enumerate the workspace glob list (it references `kimaki-packages.md` by name in
§2 instead of inlining), so there is no direct PLAN.md claim to falsify here — checked for
consistency between the two digest reports and the source file. PASS (no contradiction).

### Cited file-path existence (PLAN §2)

```
EXISTS: cli/src/discord-bot.ts
EXISTS: cli/src/cli.ts
EXISTS: cli/src/session-handler/thread-session-runtime.ts
EXISTS: cli/src/opencode.ts
EXISTS: cli/src/cli-runner.ts   (2117 lines; PLAN cites "cli-runner.ts:1569-1769" — abbreviated
                                  path, in-range line numbers, function is `run()` which contains
                                  the shared opencode-server bootstrap logic)
EXISTS: cli/src/db.ts
EXISTS: cli/src/schema.ts
EXISTS: cli/src/anthropic-auth-plugin.ts
EXISTS: cli/src/openai-auth-plugin.ts
EXISTS: cli/src/xai-auth-plugin.ts
EXISTS: cli/src/opencode-interrupt-plugin.ts
EXISTS: cli/src/context-awareness-plugin.ts
EXISTS: cli/src/cache-drift-plugin.ts
EXISTS: gateway-proxy (directory, submodule)
EXISTS: cli/src/hrana-server.ts
EXISTS: cli/src/openai-realtime.ts
```
All 15 distinct cited files/paths exist. PASS.

### Numeric-constant spot checks

```
$ grep -n -i "idle" app-server.md
434: thread/unsubscribe ... "a now-idle thread may unload later"
497: "...after the idle timeout when it has no subscribers and no active turn."
500: "Idle unload disposes the session but does not release its turn log..."
```
app-server.md confirms idle-unload behavior exists but does **not** state "30 minutes" anywhere.

```
$ grep -n -i "30" reports/omo-appserver.md
179: "unloaded after **30 minutes** of idle time."
181: "idleUnloadMinutes: 30 ... runtime.js line 83"
185: "setTimeout(...) ... handlers.js line 377 — 30-minute timer per thread entry."
```
The "30분 유휴 언로드" figure in PLAN.md Phase 3 traces to `reports/omo-appserver.md`'s direct
source-code citations (`runtime.js:83`, `handlers.js:377`), not to `app-server.md`. This is a valid
evidence trail (PLAN.md's stated methodology is "근거로 작성" against the 6 digest reports, of which
`omo-appserver.md` is one) but is **not verifiable by grepping app-server.md alone**, which is the
specific gate this task named. Flagged as PARTIAL — sourced, but not from the file the task
mandated as the grep target for this figure.

```
$ grep -n "100" app-server.md
478: "The per-thread terminal queue is capped at 100 notifications."
```
PLAN.md Phase 3's "터미널 알림 큐잉(스레드당 100개 상한)" matches this line exactly. PASS.

## 3. Results table

| # | Claim in PLAN.md | Evidence file + line | Verdict |
|---|---|---|---|
| 1 | `thread/start` used for session creation | app-server.md:169,424 | PASS |
| 2 | `thread/resume` used for session resume | app-server.md:187 (§Live Examples), 425 (table) | PASS |
| 3 | `thread/fork` used for btw/worktree fork | app-server.md:267,429 | PASS |
| 4 | `turn/start` starts a turn | app-server.md:332,440 | PASS |
| 5 | `turn/steer` queues input to active turn (used for `.queue`/interrupt-replay) | app-server.md:349,441 | PASS |
| 6 | `turn/interrupt` interrupts active turn | app-server.md:366,442 | PASS |
| 7 | `turn/diff/updated` notification for diff viewer | app-server.md:471-472 | PASS (correctly described as notification, not request method) |
| 8 | `thread/read`, `thread/list` exist | app-server.md:426-427 | PASS |
| 9 | `model/list`, `config/read` for model resolution | app-server.md:412,414 | PASS |
| 10 | `skills/list`, `mcpServerStatus/list` for skills/MCP commands | app-server.md:419-420 | PASS |
| 11 | `thread/settings/update` supports only model+effort ("부분 지원") | app-server.md:459 ("Partial: supports only session-scoped `model` and `effort`") | PASS — exact match |
| 12 | `account/read` returns `{type:"apiKey"}` only, no subscription/rate-limit data | app-server.md:416-418 | PASS |
| 13 | `account/rateLimits`/`usage` "지원하지 않는다" (not supported) | app-server.md:417-418 (`account/rateLimits/read`, `account/usage/read` both return invalid-request errors) | PASS in substance; method name in PLAN.md drops the `/read` suffix present in the doc — minor imprecision |
| 14 | Rust `gateway-proxy` submodule not initialized, excluded from Phase 0-2 | `_refs/kimaki/gateway-proxy` exists as directory on disk (checked) | PASS — directory present but PLAN's "서브모듈이 초기화되지 않은 상태" claim about submodule init state is about git submodule content, not directory presence; not independently re-verified here (out of task scope: submodule status check not requested) |
| 15 | Hrana SQLite / `cli/src/hrana-server.ts` slated for full removal | `_refs/kimaki/cli/src/hrana-server.ts` exists | PASS (file exists, matches removal-target claim) |
| 16 | `cli/src/discord-bot.ts` + `cli/src/cli.ts` are the core event loop | Files exist at `_refs/kimaki/cli/src/{discord-bot,cli}.ts` | PASS |
| 17 | `thread-session-runtime.ts` is the sole session orchestrator | `_refs/kimaki/cli/src/session-handler/thread-session-runtime.ts` exists | PASS |
| 18 | 29 import sites for `@opencode-ai/sdk/v2` | `reports/kimaki-opencode-integration.md:41` ("29 files under `cli/src` import from `@opencode-ai/sdk/v2`") | PASS — exact match |
| 19 | `cli-runner.ts:1569-1769` covers shared opencode-server bootstrap | `_refs/kimaki/cli/src/cli-runner.ts` is 2117 lines; line 1569 begins `run()` (opencode/bun install + server bootstrap) | PASS — in range, path abbreviated but unambiguous in context |
| 20 | Feature-parity checklist (§6) covers every kimaki-features.md row | `reports/kimaki-features.md` 18 rows vs PLAN.md 22 checklist items | PASS — superset, no dropped feature |
| 21 | Monorepo package list (pnpm-workspace.yaml globs) | `_refs/kimaki/pnpm-workspace.yaml` vs `reports/synthesis.md`/`kimaki-packages.md` quotes | PASS — verbatim match |
| 22 | omo idle-unload = 30 minutes (Phase 3) | `reports/omo-appserver.md:179-185` (source-code citations `runtime.js:83`, `handlers.js:377`); **not present in app-server.md** | PARTIAL — sourced from a different cited digest, not from app-server.md as the task's grep gate specified |
| 23 | Terminal notification queue capped at 100/thread (Phase 3) | app-server.md:478 | PASS — exact match |
| 24 | codex-remote-refs.md "패턴 1" (loopback-only app-server) | codex-remote-refs.md:135-137 | PASS |
| 25 | codex-remote-refs.md "패턴 3-5" (normalized approval cards) | codex-remote-refs.md:96-108 (Approvals handling section) | PASS |
| 26 | codex-remote-refs.md "패턴 6" (rehydration for reconnecting clients) | codex-remote-refs.md:236,302,361-362 | PASS |
| 27 | `Phase` count / structure (4 phases: 0-3) | PLAN.md:63,75,87,99 | PASS |

## 4. Overall verdict

**Overall: PASS**, with 2 minor findings that do not rise to hallucination or missing-feature
severity:

1. **Method-name suffix imprecision** — PLAN.md §7 writes `account/rateLimits`/`usage` instead of
   the doc's exact `account/rateLimits/read` / `account/usage/read`. The behavioral claim (not
   supported / Codex-account-only) is correct; only the literal method string is abbreviated.
2. **Cross-source citation for the "30-minute idle unload" figure** — this number is real and
   traceable to source-code line citations in `reports/omo-appserver.md` (`runtime.js:83`,
   `handlers.js:377`), but does not appear in `app-server.md`, the file this task's grep gate
   named. Not a hallucination — it is sourced elsewhere in the review's own evidence chain — but
   worth flagging because the specific verification gate requested here could not confirm it from
   app-server.md alone.

No cited app-server.md method used by PLAN.md is absent from the doc. No feature row from
`kimaki-features.md` is missing from the PLAN §6 parity checklist. The pnpm-workspace.yaml package
globs match what the digest reports claim verbatim. All 15 distinct `cli/src/*` file paths cited in
PLAN.md §2 exist in the `_refs/kimaki` checkout. No fabricated JSON-RPC method names, no fabricated
file paths, no dropped features were found.

### Required fixes (non-blocking, cosmetic)

- PLAN.md §7: change `account/rateLimits`/`usage` to `account/rateLimits/read` / `account/usage/read`
  to match the exact method names in app-server.md.
- PLAN.md Phase 3: add an inline citation `(omo-appserver.md §Idle Unload, runtime.js:83)` next to
  "30분 유휴 언로드" so the number's provenance is traceable without cross-referencing a different
  digest report.
