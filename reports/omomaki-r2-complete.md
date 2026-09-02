# omomaki 완주 계획 — 이상 상태와 Phase 분할

작성: 2026-09-02. 근거: PLAN.md v2, reports/phase0-evidence.md, reports/rpc-r0-r1-evidence.md, cli/src/omo-bridge 실측.

## 현재 상태 (증거)

- HEAD `e0ba496af5fb29ac2076b97eda42573bb1e988ed` (kimaki baseline), branch `omomaki-phase0`.
- Phase 0 브릿지는 **워킹트리에만** 존재 (미커밋): `OmoAppServerClient` + approvals + schema + input-translation + project-paths.
- `OmoRpcClient` **없음**. `omomaki-approve.ts` **없음**. Discord는 여전히 OpenCode SDK (`promptAsync` 등).
- `client.ts`는 `readline` + `omo app-server --listen stdio://` — RPC 전환 대상이며 readline은 U+2028/U+2029 버그로 금지.
- 원격은 `upstream-kimaki`만 있음. PR을 위해 `origin` = `jc01rho/omomaki` 필요.
- 사용자 교정: `~/.omo/agent/extensions`에 테스트 확장 심지 말 것. `--extension <in-repo path>` + 격리 TMPDIR만.

## 이상 상태 (Definition of Done)

Discord 스레드에 사용자 메시지가 오면 omomaki가 **세션당 1개** `omo --mode rpc --session <jsonl> --extension <repo>/cli/src/omo-bridge/omomaki-approve.ts` 자식을 띄우고, LF JSONL로 `prompt` → `agent_start`/`text_delta`/`agent_settled`를 디스코드 메시지(⬥ 텍스트, ┣ 도구, 완료 footer)로 렌더한다.

- 재개: 클래식 `--session` (멀티세션 `open_session(sessionPath)` 금지 — durable id가 바뀜).
- 진행 중 입력: `steer`. 유휴: `follow_up`. SQLite `omo_message_queue`는 Discord 전송 아이덴티티 전용.
- 승인: 확장 `tool_call` + `ctx.ui.confirm` → `extension_ui_request` → Discord 카드 → `extension_ui_response`. 타임아웃/거절은 fail-closed. `security_audit` 기록.
- 보안: stdio 전용, `PROJECT_ROOTS` canonicalization, 사용자 live extensions 디렉터리 불변.
- OpenCode 런타임 경로와 app-server `thread/*`/`turn/*` 어댑터는 제거.
- gateway-proxy 멀티테넌트는 비목표.

## Phase 분할 (순차, 각 Phase = worktree + mass-ulw DAG + PR + ultrabrain 승인 + merge)

| Phase | 목표 | 쓰기 범위 | 게이트 |
|---|---|---|---|
| P0 | 미커밋 Phase 0 브릿지+PLAN+reports 커밋/PR | `cli/src/omo-bridge/*` 기존, `cli/src/schema.ts`, `schema.sql`, tests, `PLAN.md`, `reports/` | tsc + omo-bridge/input-translation/schema tests green. `_refs/` `.omo/` 커밋 금지 |
| P1 | `OmoRpcClient` + in-repo `omomaki-approve.ts` + 격리 자식 왕복 | `cli/src/omo-bridge/rpc-client.ts` (신규), `omomaki-approve.ts` (신규), tests. Discord 파일 금지 | RED→GREEN 단위테스트 + 격리 TMPDIR prompt/settled + deny fail-closed. extensions dir 불변 |
| P2 | session-handler/discord-bot이 OmoRpcClient 사용 | `cli/src/session-handler/*`, `discord-bot.ts`, `opencode.ts` 호출부만 교체 | digital-discord: 메시지→봇 답글. OpenCode promptAsync 신규 경로 0 |
| P3 | abort/queue/model/worktree/승인 카드 UX | `cli/src/commands/*`, approvals Discord 카드, queue | 해당 e2e + fail-closed 카드 |
| P4 | app-server 어댑터/OpenCode 런타임 제거, 문서 | `adapters.ts` 폐기, PLAN.md R3, 죽은 import | tsc + omo-bridge tests + 관련 e2e |

## mass-ulw 토폴로지 (Phase당)

Wave 1: 구현 레인 (disjoint files) → Wave 2: verification 노드 (`pnpm tsc`, targeted vitest, 격리 RPC 시나리오).
ultrabrain은 **PR 이후** 리드가 별도 `task(category=ultrabrain)`로 리뷰. 수정은 `deep`. 승인까지 반복 후 merge.

## 제약

- pnpm, bun 금지. readline 금지. live `~/.omo/agent/extensions` 쓰기 금지.
- `/home/whrho/git/omomaki/.omo` 이동/삭제 금지.
- 봇 SIGUSR2는 사용자 명시 요청 때만.
- 커밋/PR/merge는 이번 요청 범위.
