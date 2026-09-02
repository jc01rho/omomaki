# omomaki RPC 전환 R0/R1 실측 증거

날짜: 2026-09-02. 대상: 설치된 omo 2026.8.31 (`/home/whrho/.local/bin/omo`).
모든 결과는 오케스트레이터가 라이브 프로브로 직접 캡처했다. 임시 스크립트/세션 파일은 검증 후 전부 삭제했으며(사용자 요청), 아래는 그 당시 캡처된 결과의 기록이다.

## R0 — 전송 계층 실측

### 세션 라이프사이클
- `omo --mode rpc --multi-session` 기동 → `get_protocol_info` → `{"protocolVersion":1,"serverVersion":"2026.8.31","capabilities":["multi_session"],"mode":"multi"}`.
- `open_session {cwd, provider, modelId}` → 성공 응답. `data.state.sessionId`(durable UUID)와 라우팅 핸들 `sessionId:"rpc-1"`이 함께 반환됨.
- `prompt` → `agent_start` → `message_start/text_start → text_delta → text_end` → `message_end` → `agent_settled` 순서로 스트리밍 확인. 최종 assistant 텍스트 "RPC-OK" 수신.
- `abort`(활성 중) → `success:true` 응답 후 `agent_settled` 1회.
- `close_session` → 응답 이후 `rpc-1` 태그 레코드 0건. 이후 `get_state`는 `unknown_session` 에러.

### 세션 재개 (결정 사항 1의 근거)
- 멀티세션 `open_session {sessionPath:<원본 jsonl>}`: **durable sessionId가 원본(01a0606a-...)과 다른 새 값(01a0606d-... 등)으로 발급**됨 — 원본 대화가 이어지지 않음.
- 클래식 모드 `omo --mode rpc --session <원본 jsonl>`: durable sessionId 원본 유지, `messageCount:4` 복원, 후속 프롬프트("codeword?")에 원래 세션에서 저장한 코드워드로 답변 — 재개 + 기억 실측 성공.
- 결론: omomaki는 **클래식 모드 + 세션당 프로세스**를 재개 경로로 채택 (PLAN.md 결정 1).

### steer / follow_up (결정 사항 2의 근거)
- 유휴 세션에 `steer`, `follow_up` 모두 `success:true` (app-server의 `turn/steer -32600`과 다름).
- 다중 `follow_up` 3건 → `get_state`의 `followUp` 배열에 순서 보존 확인.
- 활성 run 중 `steer` → `get_state.steering` 배열에 적재, `steeringMode:"all"` 규칙대로 현재 도구 루프 종료 후 소진되어 assistant 응답에 반영됨.

## R1 — 승인 경로 실측 (보안 게이트)

### 내장 권한 시스템은 RPC 스트림에 다이얼로그를 내보내지 않음
- `permissionPreset:"ask"`로 open_session 후 bash 도구 요청 → `extension_ui_request` 다이얼로그 0건, `PreToolUse` 훅만 기록되고 **도구는 실행됨** (파일 생성 확인).
- `--permission 'bash:ask'` CLI 규칙, 미신뢰 디렉터리(`projectTrusted:false`) trust 질의, 프로젝트 밖 파일 쓰기 요청 — 모두 동일하게 다이얼로그 없이 실행.
- 결론: 내장 권한 시스템의 confirm은 stderr TUI 전용이며 RPC 클라이언트에는 도달하지 않음.

### omomaki 확장 경로는 동작함 (라이브 왕복 검증)
- `~/.omo/agent/extensions/`에 배치한 임시 확장 (검증 후 **삭제 완료** — 사용자 확장 디렉터리는 원래 6개 파일만 존재):
  `export default function(pi)` + `pi.on("tool_call")` + `ctx.ui.confirm(..., {timeout})`.
- RPC 스트림에 `{"type":"extension_ui_request","method":"confirm","title":"omomaki approval","message":"Allow bash: touch ...","timeout":60000}` 도달 확인.
- 클라이언트가 `{"type":"extension_ui_response","id":...,"confirmed":false}` 회신 → **도구가 차단되고 대상 파일이 생성되지 않음을 실측** (fail-closed 거절 왕복 성공).
- 참고: 확장은 `export default` 시그니처여야 로드됨 (`export function activate`는 무시됨). 도구 훅의 `{block:true}` 반환도 확인.

## 증거 보존 상태

- 프로브에 사용한 임시 확장, /tmp 스크립트, /tmp 프로젝트 세션 파일은 모두 검증 직후 삭제함(사용자 지시). 위 수치는 삭제 전 캡처 값의 기록이며, 재현이 필요하면 PLAN.md §4의 결정 사항에 따라 동일 절차로 재실행 가능하다.
- 재현 명령 형태: `omo --mode rpc --multi-session --no-session` + stdin JSONL (섹션별 시나리오는 PLAN.md 결정 사항 1·2·6 참조).
