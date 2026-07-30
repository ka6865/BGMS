# 패치노트 → 무기도감 자동 갱신 제안·승인 파이프라인

작성일: 2026-07-30
상태: 계획(초안)

## 1. 목적과 현재 격차

관리자 화면(`components/admin/GameDataEditor.tsx` 시스템 탭)은 패치노트 동기화 버튼을
"공식 PUBG 패치노트 뉴스를 크롤링하여 무기 및 아이템 스탯 데이터를 동기화합니다"라고 설명한다.
그러나 실제 동기화 경로(`app/api/admin/patch-notes/sync/route.ts`,
`app/api/cron/patch-notes/route.ts`, `scripts/sync_patch_notes.ts`)는 `posts` 테이블에
`status='draft'` 게시글만 생성하며 `weapons` 테이블은 전혀 건드리지 않는다.

이 문서는 그 격차를 메운다. 목표는 "AI가 무기 스탯을 자동 수정"이 아니라
**"AI가 근거를 붙여 변경안을 제출하고, 관리자가 diff와 원문 인용을 보고 승인하면 적용"**이다.

### 설계 원칙

1. AI는 `weapons` 등 서비스 테이블에 절대 직접 쓰지 않는다. 제안 테이블에만 쓴다.
2. 모든 변경 항목은 패치노트 원문 인용(evidence)을 필수로 가진다.
   인용문이 원문에 실제로 존재하는지는 **코드가 문자열 검색으로 검증**한다(AI 자기검증 아님).
3. 자동 적용 없음. 관리자 승인이 유일한 적용 트리거.
4. 대상 테이블·컬럼은 화이트리스트로 제한한다.
5. 적용 이력은 스냅샷으로 남기고 되돌릴 수 있다.

## 2. 선행 조건 (P0, 이 기능보다 먼저 처리)

이 기능은 관리자 쓰기 경로를 확장하므로, 기존 쓰기 경로의 결함을 먼저 막는다.

| 항목 | 근거 | 조치 |
| --- | --- | --- |
| Discord webhook 메시지에 `ADMIN_SECRET_TOKEN`이 평문 포함된 URL 전송 | `app/api/cron/patch-notes/route.ts:286-294` (`quickSyncLink`) | 토큰 URL 제거. 관리자 UI 링크만 전송하거나 단기 HMAC 일회용 토큰 사용 |
| cron 인증이 `NODE_ENV === "production"` 조건에서만 동작 | `app/api/cron/patch-notes/route.ts:129` | 조건 제거, 전 환경에서 secret 강제 |
| `/api/admin/game-data`에 테이블·컬럼 화이트리스트 없음 (`from(category).upsert(item)`) | `app/api/admin/game-data/route.ts:22-35` | 아래 4.1의 화이트리스트 모듈을 공유해 검증 |
| 게시글 본문 sanitize가 SSR 단계에서 원본 HTML 반환 | `components/board/BoardDetailClient.tsx:28-33` | 서버측 sanitize 추가(저장 시점 + SSR 시점) |

## 3. 데이터 모델

새 마이그레이션 `supabase/migrations/<timestamp>_weapon_patch_proposals.sql`.

### 3.1 `weapon_patch_proposals`

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid PK | |
| source_post_id | bigint FK → posts(id) ON DELETE SET NULL | 수집된 배그 소식 초안 |
| source_url | text NOT NULL | 패치노트 원문 URL |
| source_text_hash | text NOT NULL | 원문 본문 SHA-256. 동일 원문 재요청 차단 |
| patch_label | text | 예: `업데이트 42.1` |
| status | weapon_proposal_status NOT NULL DEFAULT 'pending' | pending / partially_applied / applied / rejected / superseded |
| model_name | text | 사용 모델 |
| raw_ai_response | jsonb | 원본 응답 보존(AI 코칭 품질 게이트와 동일 방침) |
| validation_summary | jsonb | 자동 검증 결과 집계 |
| created_at / reviewed_at | timestamptz | |
| reviewed_by | uuid FK → auth.users | |

`source_text_hash`에 UNIQUE 인덱스를 걸어 동일 패치노트 중복 제안을 막는다.
현재 패치노트 동기화의 중복 판정은 `sync_history.last_url` 또는 `posts.title` 일치라서
제목이 수정되면 중복 생성될 수 있다. 해시 기준은 그 문제를 피한다.

### 3.2 `weapon_patch_proposal_changes`

제안 1건이 N개 변경 항목을 가진다. 승인 단위는 **항목별**이다.

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid PK | |
| proposal_id | uuid FK ON DELETE CASCADE | |
| target_table | text NOT NULL CHECK IN (weapons, attachments, ammo, consumables, throwables, vehicles) | |
| target_id | text | 기존 항목 id. insert면 NULL |
| operation | text CHECK IN ('update','insert') | |
| column_name | text NOT NULL | 4.1 화이트리스트로 제한 |
| old_value | jsonb | 제안 생성 시점의 DB 값 |
| new_value | jsonb | 제안 값 |
| evidence_quote | text NOT NULL | 패치노트 원문에서 그대로 발췌 |
| evidence_found | boolean NOT NULL | 원문 내 실제 존재 여부(코드 검증 결과) |
| confidence | numeric(3,2) | 모델 자기 신뢰도(참고용, 게이트에 쓰지 않음) |
| validation_state | text CHECK IN ('ok','stale','invalid') | |
| validation_reason | text | invalid/stale 사유 |
| decision | text CHECK IN ('pending','accepted','rejected') DEFAULT 'pending' | |
| decided_at / decided_by | | |

### 3.3 `weapon_patch_apply_log`

적용 시점의 행 전체 스냅샷(`before_row jsonb`, `after_row jsonb`)과
`proposal_id`, `change_id`, `applied_by`, `applied_at`, `reverted_at`을 보관한다.

### 3.4 RLS

세 테이블 모두 `ENABLE ROW LEVEL SECURITY` + 정책 없음(service_role 전용).
읽기는 관리자 API 라우트를 통해서만 제공한다.
`analytics_events`와 같은 방침이므로 마이그레이션에 의도를 주석으로 명시한다.

## 4. 추출·검증 파이프라인

`lib/patch-notes/` 신규 모듈로 구성한다. 현재 패치노트 로직은 3개 파일에
`identifyCategory`, `minifyHtml`, `formatAiSummaryToHtml`, 프롬프트가 거의 그대로
중복되어 있고 본문 추출 길이만 15000 / 8000 / 5000자로 갈라져 있다.
이 모듈이 공용 진입점이 된다.

```
lib/patch-notes/
  categorize.ts      # identifyCategory (3중 중복 통합)
  summarize.ts       # 요약 프롬프트 + 모델 폴백 (3중 중복 통합)
  renderHtml.ts      # minifyHtml + formatAiSummaryToHtml (3중 중복 통합)
  weaponSchema.ts    # 4.1 화이트리스트 + 값 범위
  weaponExtract.ts   # 4.2 구조화 추출
  weaponValidate.ts  # 4.3 검증 게이트
```

### 4.1 화이트리스트 (`weaponSchema.ts`)

`weapons` 테이블의 마이그레이션 파일이 저장소에 없다(Supabase 콘솔에서 수동 생성).
따라서 화이트리스트는 코드 상 단일 진실 공급원이 되며, `types/game-data.ts`의
`Weapon` 인터페이스와 일치해야 한다.

```ts
export const WEAPON_EDITABLE_COLUMNS = {
  damage:        { type: 'number', min: 0,   max: 300 },
  bullet_speed:  { type: 'number', min: 0,   max: 2000 },
  ammo:          { type: 'string', maxLength: 40 },
  type:          { type: 'enum',   values: ['AR','DMR','SR','SMG','SG','HG','LMG','Melee','Other'] },
  availability:  { type: 'string', maxLength: 120 },
  weight:        { type: 'number', min: 0,   max: 100 },
  patch_notes:   { type: 'string', maxLength: 2000 },
} as const;
```

`id`, `name`은 편집 대상에서 제외한다(신규 항목 insert에서만 지정 가능).
`/api/admin/game-data`도 이 모듈을 import해 동일 제약을 적용한다.

### 4.2 구조화 추출 (`weaponExtract.ts`)

새 의존성을 추가하지 않는다. 이미 쓰는 `@google/generative-ai`의
`responseMimeType: 'application/json'` + `responseSchema`로 JSON을 강제하고,
파싱 실패 시 이미 설치된 `jsonrepair`로 복구한다.

입력은 `PATCH_NOTE` 카테고리 본문만 사용한다(`STORE_INFO`, `DEV_LETTER`, `GENERAL`은 제외).
프롬프트에는 현재 DB의 무기 목록(id, name, 편집 대상 컬럼 현재값)을 함께 넣어
모델이 존재하지 않는 무기를 만들어내지 못하게 한다.

응답 스키마:

```json
{
  "changes": [{
    "target_table": "weapons",
    "target_id": "ar_m416",
    "operation": "update",
    "column_name": "damage",
    "new_value": 43,
    "evidence_quote": "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    "confidence": 0.9
  }]
}
```

모델 폴백은 기존 순서를 따른다: `gemini-3.1-flash-lite` → `gemini-3-flash-preview` →
`gemini-2.5-flash`. 호출 결과는 `ai_usage_logs`에 `analysis_type='weapon_patch_extract'`로 기록한다.

### 4.3 검증 게이트 (`weaponValidate.ts`)

AI 응답을 신뢰하지 않는 순수 함수. 각 change에 대해 순서대로 판정한다.

1. `target_table`이 화이트리스트에 있는가 → 아니면 `invalid`
2. `column_name`이 해당 테이블 화이트리스트에 있는가 → 아니면 `invalid`
3. `new_value`가 타입·범위·enum을 만족하는가 → 아니면 `invalid`
4. `operation='update'`면 `target_id`가 DB에 실제 존재하는가 → 아니면 `invalid`
5. **`evidence_quote`가 원문에 존재하는가** → 공백 정규화 후 부분 문자열 검색.
   실패 시 `evidence_found=false`, `invalid`. 환각 차단의 핵심 게이트.
6. `old_value`(현재 DB 값)와 `new_value`가 같으면 → `stale` (변경 불필요)
7. 위를 모두 통과하면 `ok`

`invalid` 항목은 저장은 하되 `decision`을 승인할 수 없도록 API·UI에서 차단한다.
검증 이유를 남기는 것은 추출 품질을 개선하기 위한 관측 데이터로도 쓴다.

## 5. 관리자 승인 UI

경로: `app/admin/weapon-patch/page.tsx` + `components/admin/WeaponPatchReview.tsx`.
`GameDataEditor`의 시스템 탭에 "무기 패치 제안 (N건)" 진입 카드를 추가한다.

기존 승인 UI 패턴(`app/admin/review/page.tsx` 마커 제보 승인,
`components/board/BoardDetailClient.tsx`의 초안 승격 배너)의 시각 언어를 따른다.

제안 상세 화면 구성:

- 헤더: 패치 라벨, 원문 링크, 수집 시각, 사용 모델, 자동 검증 요약(ok/stale/invalid 건수)
- 변경 항목 카드 (항목별)
  - `M416 · damage`
  - `41 → 43` diff 표시 (증가는 초록, 감소는 빨강)
  - 근거 인용문 blockquote + "원문에서 확인됨" 배지 또는 "원문 불일치" 경고 배지
  - 검증 상태 배지: 정상 / 현재값과 동일 / 검증 실패(사유)
  - 승인 / 거부 라디오. `invalid`는 승인 버튼 비활성
- 하단: "정상 항목 전체 승인", "선택 항목 적용", "제안 전체 거부"
- 적용 후: 적용 결과 토스트 + `weapon_patch_apply_log` 링크 + 되돌리기 버튼

API 라우트 (모두 `profiles.role='admin'` 검증, 기존 `verifyAdmin` 패턴 재사용):

| 라우트 | 메서드 | 역할 |
| --- | --- | --- |
| `/api/admin/weapon-patch/proposals` | GET | 목록(status 필터) |
| `/api/admin/weapon-patch/proposals/[id]` | GET | 상세 + 변경 항목 |
| `/api/admin/weapon-patch/proposals/[id]/decide` | POST | 항목별 accepted/rejected 기록 |
| `/api/admin/weapon-patch/proposals/[id]/apply` | POST | accepted 항목 적용 |
| `/api/admin/weapon-patch/apply-log/[id]/revert` | POST | 되돌리기 |
| `/api/admin/weapon-patch/extract` | POST | 특정 post/URL로 제안 수동 생성 |

## 6. 적용 (원자적 처리)

기존 `process_pending_marker_admin_action`, `merge_board_post_draft_with_images`와 같은
`SECURITY DEFINER` RPC 방식을 따른다.

`apply_weapon_patch_proposal(p_proposal_id uuid, p_actor uuid)`:

1. 제안 행 `FOR UPDATE` 락
2. `decision='accepted' AND validation_state='ok'` 항목만 선택
3. 각 항목에 대해 대상 행을 `FOR UPDATE` 락 후 **현재 값이 `old_value`와 같은지 재확인**.
   다르면 해당 항목을 `stale`로 되돌리고 건너뛴다(낙관적 동시성 제어).
   `posts` 승격의 `expectedParentRevision`과 같은 취지.
4. `before_row` 스냅샷 → UPDATE/INSERT → `after_row` 스냅샷을 `weapon_patch_apply_log`에 기록
5. 전부 적용되면 `status='applied'`, 일부만 적용되면 `partially_applied`
6. 트랜잭션 단위이므로 중간 실패 시 전체 롤백

적용 성공 후 애플리케이션 레이어에서:

- `/weapons` 캐시 무효화 — 기존 `/api/admin/revalidate` 패턴 재사용
- Discord 알림 — 적용된 무기·컬럼 목록과 적용자
- `analytics_events`에 이벤트 기록은 하지 않는다(`event_name` CHECK 제약이 17개로 고정되어 있어
  추가하려면 별도 마이그레이션 필요. 관리자 행위는 `weapon_patch_apply_log`로 충분)

`revert_weapon_patch_apply(p_log_id uuid, p_actor uuid)`는 `before_row`로 되돌리고
`reverted_at`을 채운다.

## 7. cron 연동

`app/api/cron/patch-notes/route.ts`가 요약 저장에 성공한 뒤,
`identifyCategory` 결과가 `PATCH_NOTE`일 때만 추출을 이어서 실행한다.

- 요약과 추출은 별도 Gemini 호출(프롬프트 목적이 다르고 실패 격리 필요)
- 추출 실패는 요약 저장을 되돌리지 않는다. 로그만 남기고 관리자가 수동 재실행
- 패치노트 1건당 추출 1회. `source_text_hash` UNIQUE로 강제
- 제안이 생성되면 기존 Discord 초안 알림에 "무기 변경 제안 N건 대기" 줄을 추가

`.github/workflows/daily-tasks.yml`의 `Sync Patch Notes` 스텝은 그대로 두고,
워크플로 실패 시 Discord 알림 스텝을 추가한다(현재 실패 알림이 없다).

## 8. 검증 계획

기존 테스트 관례(`tests/*.test.ts`, vitest, `*-boundary.test.ts` 네이밍)를 따른다.

| 테스트 파일 | 검증 내용 |
| --- | --- |
| `tests/weapon-patch-extract.test.ts` | 고정 패치노트 픽스처 → 기대 change 집합. JSON 파싱 실패 복구 |
| `tests/weapon-patch-validate.test.ts` | 화이트리스트 외 컬럼 거부, 범위 초과 거부, **인용문 미존재 거부**, stale 판정 |
| `tests/weapon-patch-boundary.test.ts` | 비관리자 403, invalid 항목 승인 시도 거부, old_value 불일치 시 적용 스킵 |
| `tests/weapon-patch-apply.test.ts` | 부분 적용 → `partially_applied`, 되돌리기 후 원상 복구 |

픽스처는 `tests/fixtures/patch-notes/`에 실제 패치노트 텍스트를 저장한다.
외부 네트워크 호출은 하지 않는다.

`package.json`에 추가:

```
"verify:weapon-patch": "vitest run tests/weapon-patch-extract.test.ts tests/weapon-patch-validate.test.ts tests/weapon-patch-boundary.test.ts tests/weapon-patch-apply.test.ts"
```

`verify:admin`에도 boundary 테스트를 포함시킨다.

## 9. 단계별 진행

| 단계 | 산출물 | 완료 기준 | 상태 |
| --- | --- | --- | --- |
| P0 | 2절 선행 조치 4건 | 토큰 노출 제거, cron 인증 무조건화, game-data 화이트리스트, 서버 sanitize | 화이트리스트만 완료 |
| P1 | 마이그레이션 + `lib/patch-notes/weapon*` + 테스트 | UI 없이 스크립트로 제안 생성·검증 확인 | 완료 |
| P2 | 조회/판정 API + 승인 UI | 관리자가 diff·근거를 보고 항목별 승인 가능 | 미착수 |
| P3 | 적용 RPC + 되돌리기 + revalidate | 승인 → `/weapons` 반영, 되돌리기 동작 | RPC 작성 완료, 원격 DB 적용·검증 미완 |
| P4 | cron 연동 + Discord 알림 + 워크플로 실패 알림 | 패치 당일 자동 제안 생성 | 미착수 |
| P5 | 패치노트 3중 구현 통합 | `lib/patch-notes/` 단일 진입점, 본문 길이 상수 일원화 | `categorize.ts` 분리만 완료 |

P1~P3까지가 이 기능의 최소 완결 범위다. P4는 자동화, P5는 유지보수 부채 정리다.

### P1 산출물 (구현됨)

| 파일 | 역할 |
| --- | --- |
| `supabase/migrations/20260730200100_weapon_patch_proposals.sql` | 제안·변경·적용로그 테이블, 화이트리스트 함수, 적용/되돌리기 RPC |
| `lib/patch-notes/weaponSchema.ts` | 편집 허용 테이블·컬럼과 값 제약 (단일 진실 공급원) |
| `lib/patch-notes/categorize.ts` | 기사 분류 공용 모듈 |
| `lib/patch-notes/weaponExtract.ts` | Gemini JSON 모드 구조화 추출, 응답 파싱·정규화 |
| `lib/patch-notes/weaponValidate.ts` | 검증 게이트 (인용문 대조 포함, 순수 함수) |
| `lib/patch-notes/weaponProposalService.ts` | 카탈로그 스냅샷 로드 → 추출 → 검증 → 제안 저장 |
| `tests/weapon-patch-{validate,extract,schema-parity,boundary}.test.ts` | 53개 케이스 |
| `tests/fixtures/patch-notes/update-42-1.txt` | 검증용 패치노트 픽스처 |

검증 명령: `npm run verify:weapon-patch` (boundary·parity 테스트는 `verify:admin` 에도 포함)

## 10. 남은 확인 사항

- `weapons` 등 게임 데이터 테이블의 실제 스키마와 RLS 상태는 저장소에 마이그레이션이 없어
  코드에서 역산했다. Supabase 콘솔에서 실제 컬럼·제약·RLS를 확인하고
  베이스라인 마이그레이션을 저장소에 넣어야 한다.
- 무기 변경이 `lib/pubg-analysis/constants.ts`의 무기 상수나 백팩 시뮬레이터 계산에
  영향을 주는지 확인이 필요하다. 영향이 있으면 적용 시 함께 무효화할 캐시를 정해야 한다.
