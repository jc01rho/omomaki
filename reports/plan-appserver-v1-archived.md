# omomaki — kimaki for omo

kimaki(https://github.com/remorses/kimaki)의 Discord 제어면을 유지하면서 에이전트 런타임을 OpenCode SDK에서 omo/senpi(https://github.com/code-yeongyu/senpi)의 Codex 호환 app-server로 교체한다.

이 계획의 기준 소스는 다음과 같다.

- kimaki 기준 SHA: `e0ba496af5fb29ac2076b97eda42573bb1e988ed`
- omo 설치 버전: `2026.8.12-4`, app-server 응답 버전 `2026.8.31`
- 근거 리포트: `reports/*.md`
- 최종 프로토콜/라이브 프로브 근거: `reports/final-review-evidence.md`
- Codex 원격 제어 참고: `_refs/codex-remote-control-lab`, `_refs/CodexRemote`

## 1. 목표와 범위

### 목표

- 채널=프로젝트, Discord 스레드=에이전트 세션이라는 kimaki의 핵심 UX를 유지한다.
- 메시지 스트리밍, queue, btw, abort/interrupt, 모델 전환, 이미지, 음성 전사, worktree, scheduler, diff, skills를 omo app-server 위에서 동작시킨다.
- 기존 kimaki 모노레포와 SQLite 상태 저장소를 유지하고, 에이전트 런타임 경계만 우선 교체한다.
- app-server가 제공하지 않는 기능은 조용히 흉내 내지 않고 명시적 parity gap으로 남긴다.

### 초기 범위에서 제외

- `gateway-proxy` 기반 멀티테넌트 공유 봇은 Phase 0–2에서 제외한다.
- realtime voice 채널 워커는 일반 음성 메시지 전사와 분리하며 Phase 2 종료 시 별도 결정한다.
- OpenCode 과거 세션의 완전한 omo JSONL 변환은 필수 납품이 아니다. 변환 spike 실패 시 read-only archive로 유지한다.
- 패키지 매니저를 Bun으로 바꾸지 않는다. 원본의 `pnpm@9.15.9` + Vitest + TypeScript를 유지한다.

## 2. 구현 베이스 결정

omomaki는 kimaki `cli/`만 추출하지 않고 **전체 모노레포를 포크**한다. `cli`가 `errore`, `traforo`, `subrouter`, `opencode-injection-guard`, `discord-digital-twin` 등 workspace 패키지에 의존하기 때문이다.

Phase 0 첫 작업은 다음으로 고정한다.

1. 기준 SHA `e0ba496...`의 전체 kimaki 모노레포와 Git 이력을 omomaki 루트로 가져온다.
2. `git submodule update --init errore traforo opencode-injection-guard subrouter`로 필요한 서브모듈을 초기화한다. `gateway-proxy`는 제외한다.
3. `upstream-kimaki` remote를 유지한다.
4. MIT `LICENSE`와 원저작자 고지를 유지하고 README에 파생 프로젝트임을 표시한다.
5. 변경 전 `pnpm install --frozen-lockfile`, `cd cli && pnpm tsc`, `pnpm test --run`을 통과시켜 기준선을 기록한다.

## 3. 현재와 목표 아키텍처

### 현재 kimaki

- Discord.js 이벤트/명령 처리: `cli/src/discord-bot.ts`, `cli/src/commands/*`
- 세션 상태 머신: `cli/src/session-handler/thread-session-runtime.ts`
- OpenCode 연결: `@opencode-ai/sdk/v2`, `opencode serve`
- Discord/queue/scheduler/auth 메타데이터: `<dataDir>/discord-sessions.db`
- OAuth/request shaping/interrupt: OpenCode 프로세스 안의 플러그인

### 목표 omomaki

```text
Discord
  │
  ▼
omomaki bot
  ├─ 기존 Discord 명령·포매팅·worktree·scheduler
  ├─ 기존 discord-sessions.db (상태의 단일 진실 공급원)
  ├─ OmoAppServerClient
  │    ├─ stdio JSONL framing
  │    ├─ initialize / request correlation
  │    ├─ notification + server-request routing
  │    ├─ reconnect / resume / reconciliation
  │    └─ Discord approval bridge
  ▼
omo app-server --listen stdio://
  ├─ thread/*, turn/*
  ├─ model/list, skills/list, mcpServerStatus/list
  ├─ account/providerAccounts/*
  └─ omo session JSONL
```

초기 구현은 반드시 `stdio://` 자식 프로세스를 사용한다. 네트워크 listener가 필요해지는 Phase 3 전까지 WS를 사용하지 않는다.

## 4. 필수 런타임 계약

### 4.1 연결과 초기화

`OmoAppServerClient`는 다음 상태 머신을 갖는다.

```text
stopped → spawning → initializing → ready
                         │            │
                         └── failed ← recovering
```

- stdout은 LF 구분 JSON 프레임으로만 파싱한다. 로그는 stderr로 분리한다.
- 모든 요청에 단조 증가 `id`를 부여하고 응답/에러를 상관시킨다.
- 연결마다 다른 메서드보다 먼저 다음 요청을 보낸다.

```json
{
  "method": "initialize",
  "params": {
    "clientInfo": {"name": "omomaki", "title": "omomaki", "version": "<version>"},
    "capabilities": {"experimentalApi": true, "requestAttestation": false}
  }
}
```

- `experimentalApi:true`가 필요한 이유는 `thread/settings/update`, `thread/turns/list`, `thread/items/list`를 사용하기 때문이다.
- 정상 종료 시 구독한 thread에 `thread/unsubscribe`를 보낸 뒤 child를 종료한다.
- 재시작 후 다시 `initialize`한다. `thread/loaded/list`로 현재 프로세스의 loaded thread를 확인하고, SQLite 활성 매핑 중 loaded되지 않은 항목만 `thread/resume`한다.
- 30분 idle unload로 `notLoaded`가 된 thread도 다음 Discord 입력 전에 `thread/resume`한다.
- process restart 뒤 `thread/turns/list`/`thread/items/list`는 축소 복원일 수 있으므로 Discord history rebuild는 omo JSONL의 user/assistant text를 사용한다.

### 4.2 입력 타입

설치된 **wire type**은 다음 입력을 선언하지만 실제 `turn-runtime.js::parseInput()`은 현재 `text`만 허용한다(`reports/final-review-evidence.md`).

- `text`
- `image` (`url`)
- `localImage` (`path`)
- `skill` (`name`, `path`)
- `mention` (`name`, `path`)

v1 결정:

- 모든 app-server 입력은 `text`로 보낸다.
- Discord 이미지/파일은 canonical project upload path에 저장하고 해당 경로와 사용 지시를 text prompt로 전달한다. 에이전트가 `read` 도구로 연다.
- skill/mention은 신뢰된 로컬 리소스의 이름·경로를 text prompt로 확장한다.
- Discord 음성 메시지는 봇에서 전사한 뒤 text prompt로 보낸다.
- wire/runtime 차이를 Senpi upstream에서 해결하면 직접 `image|localImage|skill|mention` 전송을 별도 호환성 테스트 뒤 활성화한다.

### 4.3 queue와 interrupt

두 UX를 혼합하지 않는다.

- `.queue`/`/queue`: 봇의 durable queue에 저장하고 현재 `turn/completed` 후 새 `turn/start`로 실행한다.
- 일반 메시지 interrupt: 3초 후 `turn/interrupt`, terminal 상태를 확인한 뒤 원문을 **항상 새 `turn/start`**로 재전송한다.
- `turn/steer`: queue나 interrupt replay에 사용하지 않는다. v1 범위에서 제외한다.

`cli/src/schema.ts`에 `omo_message_queue` table을 추가하고 `pnpm generate:sql`로 `src/schema.sql`을 재생성한 뒤 `src/db.ts::migrateSchema()`에 idempotent migration을 추가한다. 최소 필드는 다음과 같다.

```text
id, discord_thread_id, discord_message_id, omo_thread_id,
client_user_message_id, content_json,
status(queued|dispatching|running|completed|failed|cancelled),
turn_id, attempts, created_at, updated_at
```

- `status, created_at` 복합 인덱스와 `client_user_message_id` unique 인덱스를 둔다.
- WAL + `busy_timeout=5000`을 유지하고 `BEGIN IMMEDIATE` 안에서 가장 오래된 `queued` row 하나를 `dispatching`으로 바꾸어 claim한다.
- `turn/start`가 확정 실패하면 `attempts`를 증가시키고 지수 backoff 뒤 `queued`로 돌린다. 최대 시도 초과 시 `failed`로 종료하고 Discord에 알린다.
- `turn/start.clientUserMessageId`에는 stable delivery id를 넣는다.
- 응답 후 `turn_id`를 기록한다.
- 같은 app-server 프로세스에서 전송 결과가 불명확하면 `thread/items/list` user item `clientId`를 조회해 존재할 때 재전송하지 않는다.
- app-server process restart 뒤 JSONL 복원에는 `clientId`가 보존되지 않으므로 `dispatching` row를 자동 재전송하지 않는다. `uncertain`으로 표시하고 사용자가 확인 후 retry하도록 한다.
- Discord nonce는 delivery id의 SHA-256 base64url 앞 24자로 파생하고 full id↔nonce mapping을 SQLite에 저장한다.
- queued Discord 메시지 edit/delete는 동일 row를 update/cancel한다.

interrupt timer는 bot의 `ThreadSessionRuntime`에 둔다. 3초 동안 기존 turn이 자연 종료되지 않으면 `turn/interrupt`를 보내고, 동일 turn id의 `turn/completed(status=interrupted|completed)` 또는 `thread/read.status=idle`을 bounded timeout으로 기다린 뒤 새 turn을 시작한다. 대기 중 원본 Discord 메시지가 수정되면 최신 content를 사용하고 삭제되면 replay를 취소한다.

### 4.4 단일 인스턴스와 상태 소유권

- 기존 `KIMAKI_LOCK_PORT` 단일 인스턴스 계약을 유지한다.
- bot 프로세스가 app-server 자식 프로세스의 유일한 owner다.
- `discord-sessions.db`가 채널 매핑, queue, scheduler, Discord 설정의 단일 진실 공급원이다.
- omo JSONL은 에이전트 대화의 진실 공급원이다. in-memory TurnLog는 streaming 중에만 사용하고 process restart 이후 history의 진실 공급원으로 취급하지 않는다.
- 별도 JSON store나 새로운 pidfile 체계를 만들지 않는다.

## 5. 보안 불변조건

### app-server

- Phase 0–2: `stdio://`만 허용한다.
- Phase 3에서 WS를 추가할 경우 loopback + `Authorization: Bearer` 헤더 + `--ws-auth <0600 token file>`이 필수다.
- query-string token과 non-loopback 무인증 listener는 테스트에서 차단한다.

### 승인과 sandbox

라이브 프로브 결과 `thread/start.approvalPolicy:"on-request"`는 반영되지만 `sandbox:"workspace-write"`는 무시되고 `dangerFullAccess`로 남는다(`reports/final-review-evidence.md`).

- 모든 `thread/start`/`resume`/`fork`는 `approvalPolicy:"on-request"`, `approvalsReviewer:"user"`를 사용한다.
- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`을 Discord owner/admin 버튼으로 전달한다.
- subscriber가 없거나 응답 시간이 끝나면 decline한다.
- Phase 0 보안 게이트에서 실제 command/file-change가 approval request를 발생시키는지 검증한다. 발생하지 않으면 omomaki 구현을 진행하지 않고 omo permission 경로를 먼저 수정한다.

### Discord 원격 실행

omo sandbox가 full access이므로 Discord 권한이 호스트 보안 경계다.

- `!` shell과 `/run-shell-command`는 기본적으로 bot owner/admin만 실행할 수 있다. 일반 `kimaki` role에는 허용하지 않는다.
- 프로젝트 등록 시 `fs.realpath`로 canonicalize하고 설정된 `PROJECT_ROOTS` 바깥, `..`, symlink escape를 거부한다. `PROJECT_ROOTS`가 비어 있으면 shell/upload 기능을 비활성화하고 운영 모드에서는 시작을 실패시킨다.
- 모든 shell 실행은 사용자/guild/channel/cwd/command/결과를 `discord-sessions.db`의 append-only audit table에 남기고 기본 90일 보존한다.
- 파일 업로드는 등록된 프로젝트 root 안의 격리 디렉터리에만 저장하고 25MB 상한, MIME/magic-byte allowlist, symlink 검사를 적용한다.
- Discord component `custom_id`는 100자 이하, message nonce는 25자 이하를 테스트한다.

### 자격증명

- OAuth/access/refresh token은 해시하지 않는다. 재사용해야 하는 비밀은 해시로 복구할 수 없다.
- Senpi의 provider credential store와 `omo auth check|print-bearer-token`을 사용한다.
- 파일 기반 비밀은 0600 권한과 atomic write를 요구하며 로그/Discord 메시지에 출력하지 않는다.
- verification-only pairing token만 one-way hash할 수 있다.

Provider별 기본 경로를 고정한다.

| provider | 기본 경로 | fallback |
|---|---|---|
| Anthropic/Claude subscription | Senpi built-in OAuth account pool과 automatic failover | built-in 검증 실패 시 Senpi `registerProvider({oauth})` extension |
| OpenAI/ChatGPT subscription | `omo auth check` + provider-account API | 지원되지 않는 grant만 Senpi extension |
| XAI | Senpi API key/provider credential | OAuth parity가 실제로 필요할 때 Senpi extension |

단일 테넌트 v1에서 account pin은 bot 인스턴스 전역 provider pin으로 동작한다. guild별 credential pool은 gateway 멀티테넌트 단계 전까지 제공하지 않는다.

## 6. 컴포넌트 매핑

| kimaki | omomaki/omo | 결정 |
|---|---|---|
| `session.create/get` | `thread/start/resume` | SQLite에 Discord thread↔omo thread id 저장 |
| `session.promptAsync` | `turn/start` | 신규 turn 전용 |
| explicit queue | SQLite outbox + `turn/completed` 후 `turn/start` | `turn/steer` 사용 금지 |
| 3초 interrupt replay | `turn/interrupt` 후 새 `turn/start` | terminal 확인 후 replay |
| `.btw` | `thread/fork` + `turn/start` | fork 응답 thread id를 새 Discord thread에 저장 |
| 모델 전환 | `model/list`, `thread/settings/update`, `turn/start.model` | generated type과 라이브 테스트로 검증 |
| 이미지 | project upload path를 text prompt로 전달 | current runtime의 non-text 거부를 우회 |
| 음성 메시지 | bot transcription → `text` input | audio input 없음 |
| skills | `skills/list`; 선택한 trusted skill path를 text prompt로 확장 | direct skill input은 runtime 패치 전 사용 금지 |
| `/agent` | 기존 agent 정의를 Omo skill로 변환 | 명령 이름은 유지, skill 선택으로 동작 |
| agent별 tool 제한 | 직접 대응 없음 | v1 parity gap; UI에 명시 |
| MCP 상태 | `mcpServerStatus/list` | MCP prompt discovery는 직접 primitive가 없어 v1 제외 |
| Diff | `turn/diff/updated` + 실제 git diff | 공유 viewer에는 git diff 사용 |
| provider OAuth/계정 회전 | Senpi provider OAuth + `account/providerAccounts/read|pin|remove`, failover notification (`reports/final-review-evidence.md`) | bot에 토큰 저장 금지 |
| Discord 상태 DB | 기존 SQLite/Prisma/Drizzle | 보존, 호환 migration만 추가 |
| Hrana HTTP bridge | Phase 0–3 유지 | DB/lock/wake 계약 보존; 제거는 본 포팅 범위 밖 |

## 7. 단계별 실행 계획

### Phase 0 — 기준선, app-server bridge, 보안 게이트

#### 산출물

1. §2의 full-monorepo baseline import와 기존 테스트 통과.
2. `OmoAppServerClient` JSON-RPC client와 initialize/reconnect FSM.
3. `thread/start/resume/read/list/fork`, `turn/start/interrupt` adapter.
4. wire/runtime input 차이 contract test와 text-only image/skill translation test.
5. `approvalPolicy:"on-request"` live integration test와 Discord approval bridge.
6. 기존 SQLite에 `omo_thread_bindings`, `omo_message_queue`, append-only security audit table을 추가한다. schema source는 `cli/src/schema.ts`이며 `pnpm generate:sql`과 `migrateSchema()`를 함께 수정한다.

#### 승인 기준

- initialize 이전 요청을 절대 보내지 않는다.
- 한 app-server 프로세스가 여러 cwd의 thread를 처리한다.
- command/file-change approval request가 Discord owner/admin에게 전달되고 decline/accept가 app-server로 회신된다.
- interrupt는 terminal 확인 뒤 새 turn으로 replay된다.
- queue edit/delete/order가 기존 kimaki E2E와 동일하다.
- 기준선 kimaki 테스트에 회귀가 없다.

#### 검증

```bash
pnpm install --frozen-lockfile
cd cli
pnpm tsc
pnpm test --run src/omo-bridge
pnpm test --run src/omo-input-translation.test.ts
pnpm test --run src/thread-message-queue.e2e.test.ts src/queue-*.e2e.test.ts
pnpm exec tsx scripts/smoke-omo-app-server.ts --cwd ./fixtures/demo-project
pnpm exec tsx scripts/security-audit.ts --check stdio-only,approval-roundtrip,project-root
```

Phase 0 보안 게이트가 실패하면 Phase 1로 진행하지 않는다.

### Phase 1 — Discord UX parity

#### 산출물

- queue, btw, abort/interrupt
- 모델 전환
- image + voice transcription
- skill slash commands
- diff와 메시지 포매팅
- typing indicator
- `/agent` UX를 skill selection으로 보존
- shell/file-upload 보안 경계

#### 승인 기준

- queue는 실행 중 turn을 변경하지 않고 완료 후 순서대로 새 turn을 시작한다.
- normal message interrupt는 같은 app-server 프로세스 안에서 3초 후 중단하고 stable delivery id로 원문을 한 번 replay한다.
- stable delivery id로 Discord 중복 메시지가 억제된다.
- 이미지/skill은 canonical path를 포함한 text translation으로, 음성은 전사 text로 실제 turn에서 처리된다.
- shell과 upload가 owner/admin + canonical project root 경계를 벗어나지 못한다.
- `custom_id<=100`, `nonce<=25` 테스트가 통과한다.

#### 검증

```bash
cd cli
pnpm tsc
pnpm test --run src/commands src/session-handler
pnpm test --run src/queue-*.e2e.test.ts src/voice-message.e2e.test.ts
pnpm test --run src/omo-*.e2e.test.ts
pnpm exec tsx scripts/security-audit.ts --check shell-authz,upload-boundary,discord-limits
```

### Phase 2 — worktree, scheduler, provider/auth

#### 산출물

- 기존 worktree lifecycle을 omo thread cwd와 연결.
- 기존 scheduled task tables와 claim/history를 유지하고 omo turn을 실행.
- Senpi provider OAuth를 사용한다. built-in provider가 부족하면 **Senpi extension**의 `registerProvider({oauth})`에서 보완한다.
- Anthropic/OpenAI/XAI 다중 계정은 Senpi provider-account API와 failover notification을 사용한다.
- kimaki의 도구명/베타 헤더 rewrite가 필요한 provider는 bot shim이 아니라 Senpi provider extension에서 구현한다.
- 기존 OpenCode 세션은 기본 read-only archive로 유지한다. 별도 spike가 성공할 때만 omo JSONL import를 제공한다.

#### 승인 기준

- worktree create/resume/merge가 정확한 canonical cwd를 사용한다.
- scheduler는 crash/restart 후 중복 실행 없이 claim/history를 보존한다.
- `omo auth check`와 provider-account read/pin/remove/failover가 provider별로 동작한다.
- provider별 기본/fallback 경로가 위 표대로 선택되고 그 결과가 startup diagnostics에 기록된다.
- bot 프로세스와 SQLite에 provider access/refresh token을 새로 저장하지 않는다.
- 기존 `discord-sessions.db` 사용자는 destructive migration 없이 업그레이드된다.

#### 검증

```bash
cd cli
pnpm tsc
pnpm test --run src/worktrees.test.ts src/worktree-lifecycle.e2e.test.ts
pnpm test --run src/task-schedule.test.ts \
  src/anthropic-auth-plugin.test.ts src/anthropic-auth-state.test.ts \
  src/xai-auth-state.test.ts
pnpm exec tsx scripts/provider-parity.ts --providers anthropic,openai,xai
test -f "${KIMAKI_DATA_DIR:-$HOME/.kimaki}/discord-sessions.db" &&
  pnpm exec tsx scripts/migrate-dry-run.ts --verify
```

### Phase 3 — reconnect, idempotency, 운영

#### 산출물

- app-server child restart 후 initialize→thread/resume 자동 복구.
- SQLite delivery state와 `clientUserMessageId` 기반 reconciliation.
- `thread/items/list` user item `clientId`로 ambiguous send를 확인.
- Discord message delivery upsert와 stable nonce.
- JSONL 기반 history rebuild.
- 관찰가능성, health check, app-server 버전 호환성 검사.
- 필요할 때만 authenticated loopback WS daemon **또는** same-user `unix://` 중 하나를 선택한다. 두 원격 transport를 동시에 활성화하지 않는다.

#### 승인 기준

- process crash/restart 중 queue row가 유실되지 않는다.
- 같은 app-server 프로세스의 ambiguous `turn/start`는 client id가 이미 존재하면 재전송하지 않는다.
- app-server process restart를 걸친 ambiguous send는 자동 재전송하지 않고 `uncertain`으로 표시한다.
- Discord 출력은 stable delivery id 기준으로 중복 생성되지 않는다.
- subscriber 유실 시 approval은 fail closed한다.
- WS 옵션은 bearer header/auth file 없이 시작되지 않는다.
- secrets가 로그/Discord/export 파일에 노출되지 않는다.

#### 검증

```bash
cd cli
pnpm tsc
pnpm test --run src/omo-reconnect.e2e.test.ts src/omo-delivery-idempotency.e2e.test.ts
pnpm test --run src/runtime-lifecycle.e2e.test.ts
pnpm exec tsx scripts/security-audit.ts --check ws-auth,secrets-redaction,approval-fail-closed
```

## 8. Feature parity checklist

### Phase 0–1 필수

- [ ] 채널=프로젝트, Discord thread=omo thread
- [ ] turn streaming과 최종 메시지
- [ ] queue edit/delete/order
- [ ] btw fork
- [ ] abort와 3초 interrupt replay
- [ ] model switching
- [ ] images
- [ ] voice-message transcription
- [ ] skills as slash commands
- [ ] `/agent` 명령 이름 유지 + skill 선택
- [ ] diff viewer
- [ ] typing indicator
- [ ] shell/file upload security boundary
- [ ] restart/upgrade 기본 경로

### Phase 2 필수

- [ ] worktrees + merge
- [ ] scheduled tasks
- [ ] provider OAuth
- [ ] provider multi-account failover
- [ ] 기존 SQLite 무중단 업그레이드

### 명시적 parity gap

- [ ] agent별 tool allow/deny: app-server primitive 부재
- [ ] MCP prompt 자동 slash-command discovery: 직접 primitive 부재
- [ ] realtime voice: 별도 결정
- [ ] gateway-proxy multi-tenancy: Phase 3 이후 별도 결정
- [ ] OpenCode 세션 완전 변환: spike 성공 시만 제공

## 9. 데이터와 마이그레이션

기존 `<dataDir>/discord-sessions.db`를 버리지 않는다.

- `channel_directories`, Discord 설정, scheduler, bot mode는 그대로 유지한다.
- 기존 OpenCode `thread_sessions`/`session_id`를 omo id로 덮어쓰지 않는다.
- 새 `omo_thread_bindings` table을 사용한다.

```text
discord_thread_id PRIMARY KEY,
omo_thread_id UNIQUE NOT NULL,
session_path,
app_server_version,
created_at,
updated_at
```

- legacy `session_id`가 여러 Discord thread에 연결된 기존 동작은 `thread_sessions`에 그대로 남긴다. omomaki는 새 binding table만 조회하므로 id 충돌이 없다.
- fork는 새 `omo_thread_id` row를 만들고 parent Discord/omo thread id를 별도 컬럼에 기록한다.
- queue는 §4.3의 `omo_message_queue`를 사용한다.
- schema 변경 순서는 `cli/src/schema.ts` → `pnpm generate:sql` → `src/db.ts::migrateSchema()` idempotent migration이다.
- 기존 OpenCode session/event rows는 read-only archive로 남긴다.
- omo conversation은 omo JSONL이 소유한다.
- migration dry-run 결과는 `<dataDir>/migrations/omomaki-<timestamp>.json`에 기록하며 경로/프롬프트/토큰은 redaction한다.
- 기존 `bot_tokens`는 Discord 연결용으로 유지한다. provider OAuth token과 혼합하지 않는다.

## 10. 남은 리스크와 명시적 결정점

1. **sandbox:** `approvalPolicy`는 override 가능하지만 sandbox는 현재 `dangerFullAccess`다. approval integration test가 최우선 gate다.
2. **agent tool 제한:** skill mapping은 prompt/persona UX만 보존한다. tool-level parity는 omo primitive가 생길 때까지 제공하지 않는다.
3. **provider rewrite:** Claude subscription용 tool/header rewrite가 built-in provider에 없으면 Senpi extension에서 구현한다.
4. **diff fidelity:** `turn/diff/updated`는 git diff와 동일하지 않으므로 공유 viewer는 실제 git diff를 사용한다.
5. **session import:** JSONL conversion은 optional spike이며 기본값은 read-only archive다.
6. **gateway:** 멀티테넌트 수요가 확인된 경우에만 submodule을 초기화하고 별도 보안 리뷰를 수행한다.
7. **realtime voice:** core text/image/voice-message parity 완료 후 별도 ROI 결정한다.

## 최종 실행 순서

1. full-monorepo baseline import
2. app-server initialize/client + approval security gate
3. thread/turn bridge
4. queue/interrupt durable state machine
5. Discord parity
6. worktree/scheduler/provider auth
7. reconnect/idempotency
8. optional gateway/realtime/session-import work

Phase 0 보안 게이트와 기준선 테스트를 통과하기 전에는 기능 포팅을 병렬 확장하지 않는다.
