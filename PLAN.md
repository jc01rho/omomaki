# omomaki 전송 계층 전환 계획: app-server → omo RPC 모드

## 1. 요약

omomaki의 에이전트 런타임 연결을 **omo app-server(Codex 호환 JSON-RPC)**에서 **omo 기본 RPC 모드(`omo --mode rpc --multi-session`)**로 전환한다. RPC 모드는 senpi가 자체 세션 런타임에 대해 제공하는 1급(native) 전송 계층으로, steer/follow-up/권한 요청/어텐션 폴링 같은 대화 제어가 프로토콜에 내장되어 있다. 이 전환은 포팅의 후반부 단계에 해당한다: `reports/kimaki-features.md`의 피처 인벤토리는 그대로 유지하고, 아래에 명시된 매핑 테이블에 따라 각 피처의 전송 방식만 교체한다.

검증 근거(라이브 프로브, 이 머신의 omo 2026.8.31 기준):
- 세션 관리: `open_session` (`id` 태그 포함), `get_state`, `get_entries`, `get_available_models`
- 스트리밍: `prompt` → `agent_start` → `message_start`/`text_start` → `text_delta` → `text_end` → `message_end` → `agent_settled`
- 유휴 상태에서의 steer/follow-up: 자연스럽게 큐잉되며 `agent_start`가 유휴 turn의 `agent_end` 뒤에 이어짐 — app-server의 `-32600 No active turn`과 달리 에러 없음
- `get_state`로 큐잉된 후속 요청이 보임: `followUpMessages` 배열, `retryPrompt`는 `steerPrompt`와 별개 필드
- 어텐션 폴링: `get_state`/`get_entries`는 각 호출 시점의 사용량/비용/토큰을 반환 — 푸시 업데이트 방식 대비 폴링 필요

**변경되지 않는 것:** Discord 레이어, SQLite 상태 저장소, 보안 게이트(approval 정책), 워크트리/스케줄러/피처 패리티 목표.

## 2. 배경

v1 계획(`reports/plan-appserver-v1-archived.md`)은 app-server의 Codex 호환성을 채택했다. 검증 결과:
- stdio 초기화/재접속 FSM: `reports/final-plan-review.md`에 명시
- wire가 5개의 입력 변형을 선언하지만 런타임이 text만 수락(`reports/final-review-evidence.md`)
- 30분 idle-unload 및 세션 JSONL 소유권 확정
- 7개 bridge 레인(모두 `cli/src/omo-bridge/`)의 타입 및 어댑터는 이미 구현·검증 완료

그러나 Phase 0 통합 검증에서 두 가지 사실이 드러났다: (1) 128k 컨텍스트 러너가 136.6k의 누적 컨텍스트를 처리하지 못해 app-server 통합 레인이 실패했다는 점, (2) `turn/steer`가 유휴 세션에서 `-32600`을 반환해 queue 재전송 경로가 봇 측 SQLite outbox에 의존해야 한다는 점. RPC 모드는 두 문제 모두에 더 적합하다: senpi가 일상적으로 사용하는 네이티브 계층이며, 유휴 steer/follow-up이 자동으로 큐잉되기 때문.

## 3. 이전 계획과의 차이

| 항목 | app-server 계획 (v1) | RPC 모드 계획 (v2) |
|---|---|---|
| 세션 생성 | `initialize` → `thread/start` | `open_session` (`sessionId`를 클라이언트가 선택) |
| 사용자 입력 | `turn/start { input }` | `prompt { message }` |
| 진행 중 입력 | `turn/steer` (활성 turn만, 유휴 시 에러) | `steer` (항상 허용, 유휴 시 큐잉) |
| 후속 입력 | 봇 측 SQLite 큐잉 후 재전송 | `follow_up` (세션당 큐잉) |
| 스트리밍 | `turn/completed` 알림, `thread/items/list` | `agent_start`/`text_delta`/`agent_settled` 이벤트 |
| 최종 상태 | `turn/completed` 알림 | `get_state` → `isSettled` / `agent_settled` 이벤트 |
| 대화 내역 | `thread/read` / 세션 JSONL 재구성 | `get_entries` |
| 모델 전환 | `thread/settings/update` | `set_model` / `set_thinking_level` |
| 계정/모델 발견 | `model/list` | `get_available_models` |
| 승인 요청 | 서버 요청 (`item/commandExecution/requestApproval`) | 세션 이벤트 알림 (`omx_permission_request`) |
| 히스토리 | `thread/resume` / `thread/read` | `open_session` 재호출 (동일 `sessionId`, `--no-session` 없이) |
| 연결 수명 | 재시작 후 `initialize` 필요 | 재시작 후 세션별 재 `open_session` 필요 |

### Phase 0에서 구현되어 재사용 가능한 부분
- `OmoAppServerClient`: JSON-RPC 프레이밍, initialize FSM, 요청-응답 상관
- `ApprovalBridge`: fail-closed 승인 로직 — 로직은 유지하고 응답 라우팅만 `replyToServerRequest`에서 `respondToPermissionRequest`로 교체
- SQLite 테이블 (`omo_thread_bindings`, `omo_message_queue`, `security_audit`)
- `project-paths.ts` 경로 검증
- `input-translation.ts`: 텍스트만 강제하는 검증 — RPC 모드는 문자열 `message`를 받으므로 단순화 가능하나, 프롬프트 주입 방어와 멀티모달 확장성을 위해 유지

### 폐기되는 부분
- `thread/*`, `turn/*`, `item/*` 어댑터
- Codex 호환 JSON-RPC FSM (v2 RPC는 일반 JSONL 상관으로 충분)
- steer가 아닌 경로를 위한 outbox 재전송 (RPC는 유휴 큐잉을 네이티브로 지원)

## 4. 결정 사항 (확정 — 추가 논의 불필요)

1. **클래식 RPC 모드 + 세션당 프로세스 1:1**: `omo --mode rpc --session <file>`로 재개 (durable sessionId 유지, messageCount 복원, 대화 기억 실측 완료). 멀티세션 모드의 `open_session(sessionPath)`은 새 sessionId를 발급해 재개에 부적합 (R0 실측). 내부 `sessionId`는 `rpc-<discordThread.id>` 형식.
2. **steer/follow-up 정책**: 진행 중 세션에는 `steer`, 유휴 세션에는 `follow_up`. 유휴/활성 모두 성공 응답이며 서버 측에서 큐잉 (R0 실측: active 중 steer는 `steeringMode:"all"` 규칙으로 도구 루프 후 소진, follow_up 다중 큐잉은 followUpMessages로 확인). 큐 재전송 루프 폐기. SQLite `omo_message_queue`는 Discord 방향의 전송 아이덴티티용으로만 유지.
3. **`clientUserMessageId`를 프롬프트 선두에 포함** (`[id:<uuid>] …`) — 스트리밍 시 사용자 메시지에 포함되어 재접속 시 중복 전송 방지. Discord `message.id` 기반.
4. **모델 라우팅은 자동** (`get_available_models` 응답 사용) — `.queue`에 저장된 명시적 `model:` 접두사만 수동 라우팅 힌트로 인정.
5. **`agent_settled` 완료 감지.** `get_state` (`isSettled`, `steerPrompt`, `followUpMessages`, `retryPrompt`)는 재접속 조정 시에만 사용. 턴 종료 후 폴링 없음.
6. **승인은 omomaki 소유 확장으로 구현** (R1 실측 완료: senpi 내장 권한 시스템은 RPC 스트림에 다이얼로그를 내보내지 않지만, **omomaki 확장의 `tool_call` 훅 + `ctx.ui.confirm`은 RPC 스트림에 `extension_ui_request{method:"confirm"}`로 도달하며 `extension_ui_response`로 승인/거절 회신이 동작한다.** 거절 시 도구가 차단되고 파일이 생성되지 않음을 실측). omomaki 확장(예: `omomaki-approve.ts`)이 bash/edit/write 도구를 가로채 Discord로 승인 카드를 보내고, 타임아웃 60초 또는 거절 시 `{block:true}`로 fail-closed한다. 승인 정책은 `security_audit` 테이블에 기록한다.
7. **어텐션 폴링**: `agent_settled` 수신 시 1회 `get_state`. 이후 폴링 없음 (turn당).
8. **에러 응답은 `id`와 `error` 필드로 식별** (성공 응답은 `ok:true`). 재시도 불가 에러 시 Discord에 실패 카드 게시.
9. **STDIO 전용** — Phase 3까지 루프백 전용 또는 stdio. 원격 리슨이 필요하면 이후 결정.
10. **텍스트 전용 입력** 유지: `input-translation.ts`를 프롬프트 조립기로 사용.

## 5. 마이그레이션 단계

### Phase R0 — 재검증 및 구조 결정 (선행 조건)
- `--no-session` 없이 재 `open_session` 시 히스토리 재개 검증
- 정상 종료 시 세션 파일 상태 확인
- `steer`/`follow_up`의 실제 큐잉 관찰
- 폐기할 부분 최종 확정 (v1 구현물 중 유지 vs 삭제)
- 게이트: 모든 결정 사항이 라이브 관찰로 뒷받침됨

### Phase R1 — 클라이언트 교체
- `OmoRpcClient` 구현 (app-server 클라이언트와 동일한 안전 기준: stdio 전용, 재접속 FSM)
- 승인 브리지가 RPC 알림을 처리하도록 수정
- app-server 전용 모듈 제거
- 게이트: 로컬 세션에서 open → prompt → settled → entries 왕복 성공

### Phase R2 — Discord 통합
- 스트리밍/최종 상태 라우팅을 RPC 이벤트 기반으로 교체
- steer/follow-up 정책 적용, SQLite outbox 역할 축소
- 세션/바인딩 라우팅은 RPC의 클라이언트 선택 `sessionId`를 사용
- 게이트: Discord 샌드박스에서 메시지 → 스트림 → 완료 흐름 정상 동작

### Phase R3 — 정리 및 문서화
- v1 계획 아카이브 유지 (`reports/plan-appserver-v1-archived.md`)
- 이 문서를 신규 PLAN으로 승격, v1의 `PLAN.md`는 교체
- 위험 등록부는 신규 전송 계층에 맞게 갱신

## 6. 리스크

| 리스크 | 등급 | 비고 |
|---|---|---|
| `omx_permission_request` 미수신 시 승인 실패 | 높음 | 타임아웃 자동 거절로 방어. 실제 도구 호출 시나리오로 e2e 검증 필요 |
| 재 `open_session` 시 히스토리 재개 실패 | 높음 | R0에서 검증 전까지 신규 세션만 허용하는 fallback 유지 |
| 긴 turn에서 어텐션 폴링 미세 조정 필요 | 중간 | `agent_settled` 1회성 get_state로 최소화 |
| 이벤트 스트림 과다로 Discord 스로틀 | 중간 | 이벤트 배치 처리 + 스로틀 전략 필요 |
| 세션 파일 충돌 (동일 sessionId, 다른 cwd) | 낮음 | sessionId에 Discord 스레드 ID를 사용하므로 1:1 대응 |

## 7. v2 계획의 명시적 비목표

- v1 app-server 코드 경로 유지 (완전 교체)
- 히스토리 재개 실패 시의 자동 재시도 (R0에서 검증된 경로만 사용)
- 멀티모달 입력 (계획상 Phase 0+ 범위 외)

## 8. v1 계획에서 승계되는 목표

- 보안 게이트: stdio 전용, fail-closed 승인, `PROJECT_ROOTS` 경로 검증 — 그대로 유지
- 피처 패리티: `reports/kimaki-features.md` 전체 (전송만 교체)
- 데이터 마이그레이션: SQLite 스키마 유지 (`omo_thread_bindings`가 RPC `sessionId`를 저장하도록 컬럼 의미만 확장)

## 9. 오픈 질문 (차단 아님 — 구현 중 해결)

- `steer`/`follow_up`의 실제 큐잉 한도 (세션당 몇 개까지인지) — 필요 시 관찰
- `respondToPermissionRequest`의 정확한 페이로드 — R1에서 첫 실제 승인 요청 발생 시 확인
- `retryPrompt` vs `steerPrompt`의 시맨틱 차이 — 재접속 조정 로직 구현 시 확인
