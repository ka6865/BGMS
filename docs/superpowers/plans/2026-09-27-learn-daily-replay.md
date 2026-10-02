# /learn 일일 복기 고도화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전날 경쟁전 우승 경기를 모드별로 쉽게 복기하는 화면을 만들고, 공통 근거와 검증을 고도화한 다음 모델을 다시 평가한다.

**Architecture:** 기존 일일 경기 수집기·근거 추출기·AI 선택기·지도 컴포넌트를 확장한다. 날짜·모드별 발행과 구조화된 장면을 저장하고 서버에서 읽는다. 모델 비교는 운영과 같은 입력 생성·검증 함수를 호출하는 오프라인 실행 스크립트로 둔다.

**Tech Stack:** 현재 설치된 Next.js 16.3.3, React 19, TypeScript, Supabase, react-leaflet, Gemini SDK, Vitest. 새 의존성 없음.

**Spec:** [2026-09-27-learn-daily-replay-design.md](../specs/2026-09-27-learn-daily-replay-design.md)

**상태:** 2026-09-28 로컬 구현·통합 검증을 진행했다. Tasks 1~5의 구현·회귀 검사를 완료했다. 모델 품질은 균등한 2라운드 56건 기준으로 현재 모델 유지·교체 판단 보류다. 후속 한도 재검증까지 59/84건 관측했으며 25건 미완료다. 무료 일일 20회라는 단정은 철회했고, 65초 간격·5분 대기 후 3.6~3.8의 429 지속과 Lite 성공을 기록했다. 커밋·운영 적용·배포는 하지 않았다. 단계별 “실패 먼저 확인” 중 기록이 없는 항목은 완료로 소급 표시하지 않는다.

## Global Constraints

- 초기 플랫폼·시점 범위는 기존 서비스와 같은 Steam·TPP다. FPP를 TPP로 조용히 합치지 않는다.
- KST 전날 00:00 이상, 다음 날 00:00 미만의 경기 시작 시각을 사용한다.
- 공개 상황·행동·결과는 근거에서 조립한다. 자유 산문은 재평가용 출력에만 둔다.
- 같은 날짜·모드 동시 실행은 한 건만 남긴다. 기존 발행물·링크·서버 전용 권한을 보존한다.
- 열람마다 원본 텔레메트리나 Gemini를 호출하지 않는다.
- 실행 전체 12분 제한, 모드당 상위 20명·최근 최대 14경기, 검증 후보 최대 3경기/모드를 사용한다.
- 새 코드를 쓰기 전에 해당 체크아웃의 `node_modules/next/dist/docs/`와 관련 AGENTS.md를 읽는다. 준비 과정에서는 `page.md`의 Promise params와 `redirecting.md`를 확인했다.

## Review Focus

1. 입력에서 빠진 소생을 모델 오류로 채점하는 문제 → Task 1·5의 입력 완전성 검사.
2. 같은 날짜의 두 모드·같은 모드 동시 발행·429 → Task 3의 독립 발행과 충돌 검사.
3. 상대 팀과 재교전하거나 두 교전이 겹치는 상황 → Task 1·2의 팀 ID와 시간별 근거 검사.
4. 최종 아군 킬 이후 자기장 사망으로 끝나거나 위치 표본이 빠진 경기 → Task 2·4의 종료·지도 검사.
5. 구버전 JSON·기존 날짜 URL·모바일 하단 메뉴 → Task 3·4의 호환성과 실제 브라우저 검사.

## Task 1: 비교 입력 누락을 고치고 공통 근거를 고정한다

**Files:** 수정 `lib/learn/dailyEvidence.ts`, `lib/learn/dailyCombatStory.ts`, `lib/learn/dailyAi.ts`, `tests/daily-ranker-evidence.test.ts`, `tests/daily-combat-story.test.ts`; 생성 `tests/fixtures/learn/daily-regressions.json`, `tests/daily-model-input.test.ts`.

**Interfaces:** `DailyEvidenceFact`에 원본 `sourceIndices: number[]`와 필요한 인물·팀·무기 필드를 추가한다. `dailyAi.ts`에 `buildDailyModelInput(evidence: DailyEvidence)`를 두며 운영·비교가 같은 반환값을 사용한다. 이 반환값은 `evidenceVersion`, 경기 identity, 전체 검증 `facts`, 명단, 교전, 무기 획득, 위치·자기장과 한계를 포함한다. 텍스트만 보고 ID나 팀을 다시 추정하지 않는다.

- [ ] 기존 원본에서 지난 오류를 재현하는 최소 이벤트를 추출해 계정·닉네임을 일관되게 익명화한다. 원본 인덱스·기대 시각·이벤트 유형과 각 기대값의 근거를 fixture에 함께 남긴다. 원본 전체를 저장소에 복제하지 않는다.
- [ ] `buildDailyModelInput` 출력에 소생 근거가 존재하는 회귀 검사를 먼저 추가한다. 01:36 첫 피해와 02:16 기절, 02:59 기절과 03:12 처치, MG3 상대 팀, 소생자/대상, 획득/발사 구분도 fixture의 기대값과 대조한다. 반환된 ID가 존재한다는 검사만으로 끝내지 않는다.
- [ ] `npx vitest run tests/daily-model-input.test.ts tests/daily-ranker-evidence.test.ts tests/daily-combat-story.test.ts`로 추가한 회귀 검사가 실패하는 것을 확인한다.
- [x] 추출 결과의 근거·시각·팀 연결을 보완하고 공통 입력 함수를 구현한다. 기존 `facts`를 빠뜨린 임시 비교 입력 구성은 새 실행기에 복사하지 않는다. 원본 이벤트의 시각 기준은 추출기와 일치시킨다.
- [x] 같은 검사를 통과시키고, `tmp` 없이도 새 회귀 검사가 실행됨을 확인한다. 합성 최소 fixture 결과와 실제 전체 경기 검증 결과는 따로 기록한다.
- [ ] 변경과 테스트를 한 단위로 검토·커밋한다.

## Task 2: 핵심 장면과 공개 해설을 구성한다

**Files:** 생성 `lib/learn/dailyScenes.ts`, `tests/daily-scenes.test.ts`; 수정 `lib/learn/dailyAi.ts`, `lib/learn/dailyEvidence.ts`, `lib/learn/dailyStories.ts`, `tests/daily-ranker-story.test.ts`.

**Interfaces:** `dailyScenes.ts`에서 `DailyScene`과 `buildDailySceneCandidates(evidence: DailyEvidence): DailyScene[]`를 내보낸다. 장면은 `id`, `kind`, `startSeconds`, `anchorSeconds`, `endSeconds`, `evidenceIds`, `situation`, `action`, `outcome`, 선택적 `lesson`, 선택적 `mapSnapshot`을 가진다. `kind`는 `opening | movement | combat | recovery | finish`. 지도는 기존 `BriefingMap` snapshot 타입을 재사용하되 표본 시각과 출처를 보존한다. `validateDailySceneSelection(value: unknown, candidates: DailyScene[])`는 `{ scenes, usedFallback, rejectedReasons }`를 반환한다.

- [ ] 중복/없는 ID, 역순, 장면 0개, 최종 아군 킬 이후 자기장 종료, 재교전·동시 교전의 팀 혼동, 위치 표본 누락을 검사하는 실패 테스트를 추가한다. 같은 근거만 반복해 3~5개를 채우는 입력을 거절한다.
- [ ] `npx vitest run tests/daily-scenes.test.ts tests/daily-ranker-story.test.ts`로 새 검사의 실패를 확인한다.
- [x] 확인된 근거에서 장면을 만들고, AI는 그 후보 ID를 선택하도록 바꾼다. 코드가 시간순으로 정렬하고 필요한 종료 장면을 보완한 경우 `usedFallback`에 남긴다. 3개 미만의 유효 장면이면 학습용 신규 발행 후보에서 제외한다.
- [x] `상황 / 행동 / 결과`를 근거에서 생성하고, 해당 장면의 행동이 확인된 경우에만 검토된 `lesson` 문구를 연결한다. 우승의 원인·시야·엄폐를 생성하는 규칙은 추가하지 않는다.
- [x] 새 story에 장면·버전·선택 검증 결과를 저장하는 타입을 추가한다. 구버전 story의 새 필드는 선택값으로 읽는다. `DAILY_STORY_PROMPT_VERSION`을 갱신한다.
- [x] 장면 지도용 원의 중심·반경과 위치 표본을 저장한다. 없는 표본은 숨기고 표본 사이 선을 실제 주행 경로로 표현하지 않는다.
- [ ] 테스트를 통과시키고 두 기존 실경기로 생성된 장면을 원본과 대조한 후 검토·커밋한다.

## Task 3: 날짜·모드별 발행과 조회로 확장한다

**Files:** 수정 `scripts/publish_daily_ranker_story.ts`, `lib/learn/dailyEvidence.ts`, `lib/learn/dailyStories.ts`, `.github/workflows/daily-ranker-story.yml`, `tests/daily-ranker-story.test.ts`; 생성 `tests/daily-ranker-publication.test.ts`, 로컬 검증 뒤 생성하는 신규 `*_daily_ranker_stories_by_mode.sql` 마이그레이션.

**Interfaces:** `dailyStories.ts`에서 `DailyMode = 'solo' | 'duo' | 'squad'`를 내보낸다. `getDailyRankerStory(day: string, mode: DailyMode)`와 `listDailyRankerStoriesForDay(day: string)`로 조회를 분리한다. `publishDailyRankerStory`의 options에 `mode: DailyMode`를 추가하고, 일괄 실행 진입점은 공통 요청 캐시·시간 예산을 공유하면서 미발행 모드를 순회한다. `isWinningMatch`와 `buildDailyEvidence`가 같은 모드·커스텀 경기 검증 기준을 사용하게 한다.

- [x] 실제 매치와 텔레메트리를 대조해 최근 모드 지원을 확인한다. 솔로 원본을 임의로 재분류하지 않는다. 듀오 원본을 확보하고 두 팀원 기록이 모두 포함되는지 검증한다. 리더보드 출처와 경기 지역을 별개로 보관한다.
- [ ] 같은 날짜 솔로+듀오+스쿼드, 같은 모드 동시 실행, 기존 행 재시도, 다른 날짜 match ID 충돌, KST 23:59:59/00:00:00, 한 모드 실패·429를 테스트에 추가하고 실패를 확인한다.
- [x] 신규 마이그레이션으로 `(day_kst, mode)` PK와 듀오 제약을 적용한다. 기존 행·`match_id` unique·RLS·권한을 보존한다. 로컬 DB에서 두 모드 insert 성공과 같은 모드 중복 실패, 기존 데이터 보존을 확인한다. 운영 DB 적용은 준비 문서 작업에 포함되지 않는다.
- [x] 존재 확인·insert 충돌 후 조회에 모드를 포함하고, 선택 실패가 다른 모드 성공을 지우지 않도록 한다. 공유 API 429는 호출을 중단하고 다음 실행에서 미완료 모드를 재시도한다.
- [x] 설계의 탐색 한도 내에서 후보를 선택한다. 검증된 3경기 중 유효 장면 수가 많고 최근 7일 반복이 적은 경기를 우선한다. 모든 계정·매치 조회는 실행 내 중복을 제거한다.
- [x] 기존 구독 없는 서버 조회 구조를 유지하고, 순위 조회 시각·시즌·출처를 저장한다. 기존 데이터에 없는 조회 시각을 발행 시각으로 대신 쓰지 않는다.
- [ ] `npx vitest run tests/daily-ranker-publication.test.ts tests/daily-ranker-story.test.ts tests/daily-ranker-evidence.test.ts`와 변경 범위의 로컬 마이그레이션 검사를 통과시킨다. 검토·커밋한다.

## Task 4: `/learn`에 장면형 복기 화면을 연결한다

**Files:** 수정 `app/learn/page.tsx`, `app/learn/daily/page.tsx`, `app/learn/daily/[day]/page.tsx`, `components/learn/BriefingMap.tsx`, `BriefingMapShell.tsx`; 생성 `app/learn/daily/[day]/[mode]/page.tsx`, `components/learn/DailySceneViewer.tsx`, `tests/daily-scene-viewer.test.ts`. 기존 `DailyBattleGuide`·`DailyRouteMapShell`은 구버전 상세 표시에서 재사용한다.

**Interfaces:** `DailySceneViewer({ scenes, mapId }: { scenes: DailyScene[]; mapId: string })`가 선택 장면 하나를 소유하고 해당 지도·해설·이전/다음 제어를 렌더링한다. 상세 Server Component는 검증된 날짜·모드로 story를 읽는다. 기존 지도 리플레이 연결은 경기별 실제 보관 identity가 있을 때만 제공한다.

- [ ] 날짜·모드 카드 링크, 이전/다음 선택과 지도 시각 동기화, 빈 장면·없는 표본·구버전 상세를 검사하는 테스트를 추가하고 실패를 확인한다.
- [x] `/learn` 상단에 전날 3개 모드 카드를 만들고, 없는 분석과 과거 경기를 날짜로 구분한다. 목록 key와 URL 모두 날짜·모드를 사용한다.
- [x] 새 상세에 장면 뷰어를 연결한다. 기존 날짜 URL은 한 편일 때 해당 모드로 연결하고 여러 편일 때 그날 목록을 보여준다. `params`는 설치된 Next.js 문서대로 await한다.
- [x] 지도는 기존 동적 로딩·좌표 보정·타일을 재사용한다. 선택한 장면의 snapshot과 간단한 범례를 보여주고 전체 기록은 접어둔다. 지도 오류가 텍스트 열람을 막지 않게 한다.
- [x] 키보드 조작·선택 상태·명시적 버튼 이름을 확인한다. `375×667`, `390×844`, `430×932`, `1280×720`에서 실제 브라우저로 탐색, 줄바꿈, 터치 영역, 하단 메뉴, 로딩/빈/오류 상태를 확인한다.
- [ ] `npx vitest run tests/daily-scene-viewer.test.ts tests/learn-briefing-evidence.test.ts`와 `npm run verify:core`를 통과시키고 브라우저 확인 결과를 남긴 뒤 검토·커밋한다.

## Task 5: 고도화된 흐름으로 모델 비교 실행기를 만든다

**Files:** 생성 `scripts/compare_daily_models.ts`, `tests/daily-model-comparison.test.ts`; 수정 `lib/learn/dailyAi.ts`의 호출부를 모델 ID·공통 입력을 받을 수 있도록 최소 분리한다. SDK와 로컬 fixture 읽기는 기존 의존성을 사용한다.

**Interfaces:** 스크립트는 `--manifest=<path> --models=<ids> --runs=3 --output=<path>`를 받는다. 기본은 입력 검증과 예상 호출 수 출력만 수행하고 `--run`이 있을 때 모델을 호출한다. manifest에는 경기·원본 파일 경로·SHA-256·근거 버전·필수 근거 묶음이 있다. 각 결과는 run/match/model/attempt identity, 입력 해시, 원본 응답, 검증 결과, 게시 결과, latency·usage를 가진다. 키나 인증 헤더는 저장하지 않는다.

- [ ] 입력에 없는 필수 소생을 `input_missing`으로 거절, 없는 근거 ID를 출력 오류로 분류, fallback을 모델 정답으로 계산하지 않음, 실패 호출 누락 방지, 서로 다른 입력 해시 혼합 거절 테스트를 추가하고 실패를 확인한다.
- [x] Task 1의 공통 입력과 Task 2의 선택 검증을 그대로 호출한다. 기존 임시 자유 해설 스크립트는 과거 자료로 보관하고 운영 비교와 분리한다.
- [x] 실제 호출 가능한 ID를 Models API로 확인한다. 현재 운영 모델도 비교에 포함하고, 호출 불가 ID는 결과에 기록한다. 모든 후보에서 공통으로 지원하는 생성 설정을 기록한다.
- [ ] 첫 두 실경기로 입력 완전성을 점검한 뒤, 모드별 최소 3경기·모델당 3회를 준비한다. 고정된 같은 입력을 사용하며 모델 실행 순서를 순환한다. 429/503/타임아웃만 최대 3시도, 내용 오류는 재추첨하지 않는다.
- [x] JSONL로 매 시도 직후 결과를 저장해 중간 중단에도 이미 나온 결과를 남긴다. 부분 실행은 부분 실행으로 보고하며 누락·실패를 성공 분모에서 제외해 숨기지 않는다.
- [ ] 토큰·캐시·재시도 포함 지연과 형식/사실/누락/근거 없는 주장/검증 거절/대체율을 분리 집계한다. 가독성·학습성은 블라인드 인간 검토 양식으로 남긴다. 임의 가중 합산 점수나 자동 모델 전환은 만들지 않는다.
- [ ] `npx vitest run tests/daily-model-input.test.ts tests/daily-model-comparison.test.ts tests/daily-scenes.test.ts`를 통과시키고 오프라인 dry-run이 모델 호출을 하지 않음을 확인한다. 검토·커밋한다.

## Task 6: 통합 검증 후 새 비교를 실행하고 모델을 재판단한다

**Files:** 수정 `docs/daily-ranker-story.md`, identity 변경을 반영하는 `docs-private/.project_context.md`; 생성 실제 실행일의 `docs/experiments/YYYY-MM-DD-learn-model-reevaluation.md`.

- [x] Tasks 1~5의 테스트, `npm run verify:core`, 필요한 로컬 DB 검증과 모바일 QA를 통과시킨다. 현재 22개 기존 테스트 통과만으로 이 단계를 완료 처리하지 않는다.
- [x] 과거 오류 경기·솔로·새 듀오의 생성 장면을 원본으로 확인한다. UI에 나온 시각·주체·팀·무기와 경기 종료를 점검한다. 위치·소생 등 필수 입력이 누락되면 비교 전에 고친다.
- [x] manifest와 공통 입력을 고정하고 dry-run의 경기·모델·횟수와 예상 최대 호출 수를 기록한다. 9경기·4모델·3회가 모두 가능하면 기본 108호출이며 기술 실패 재시도는 별도다. 데이터 미확보나 호출 불가 모델은 결과의 제한으로 남긴다.
- [x] 그 다음에만 `--run`으로 새 비교를 실행한다. 자유 해설 실험을 추가할 경우 별도 output과 별도 호출 수로 기록한다.
- [x] 모델별 원본/검증/게시 품질을 표로 작성한다. 기존 평가의 입력 누락을 수정한 효과와 새 모델 차이를 섞지 않는다. 지원 모드별 표본 수·원본 채택률·커버리지·실패율·캐시·비용·전체 지연·인간 평가 유무를 공개한다.
- [x] 설계의 판정 기준으로 모델 유지/교체/판단 보류를 결정한다. 인간 평가가 없으면 가독성 우열을, 미확보 모드가 있으면 전체 모드 품질을 단정하지 않는다. 운영 모델 전환은 결과 보고와 분리한다.
- [ ] 운영 문서에 날짜·모드별 재시도, 구버전 링크, 원본 누락 시 처리와 새 평가 보고서 링크를 반영하고 검토·커밋한다.

## 준비 단계에서 수행한 확인

- [x] 현재 코드·발행 스키마·일일 워크플로·장면 지도 구조 확인.
- [x] 지난 비교 입력과 원본을 대조해 소생 입력 누락을 확인하고 기존 보고서 보정.
- [x] 로컬 솔로 매치와 텔레메트리의 `competitive + solo` 일치 확인.
- [x] 과거 응답의 캐시 차이와 최종 시도만 저장하는 제한 확인.
- [x] `npx vitest run tests/daily-ranker-story.test.ts tests/daily-ranker-evidence.test.ts tests/daily-combat-story.test.ts tests/learn-briefing-evidence.test.ts`: 4개 파일·22개 테스트 통과.
- [x] 고도화 설계와 구현·모델 평가 순서를 문서화. 제품 코드·운영 DB·모델 설정 변경과 신규 비교 호출은 아직 실행하지 않음.

## 실행 보완 기록 (2026-09-28)

- GPT-6 Luna 서브에이전트를 사용했고, 6개라는 수량 요구로 해석한 것은 정정했다. 최종 통합은 주 에이전트가 수행했다.
- 소생 누락 외에 발사 무기 정규화, 원본 출처, 재착지 ID 중복, 교전 좌표 cm/m, 차량 제목을 수정하고 회귀 검사를 실행했다.
- 기존 `.test.ts` Vitest 패턴을 유지하고 새 의존성을 추가하지 않았다.
- 모드별 3경기 계획 중 솔로는 확인 가능한 1경기만 확보했다. 총 7경기·4모델·3회=84 trial이며 솔로 일반화는 제한한다.
- 예비 호출 중 차량 제목 오류와 서버 재시도 대기시간 미준수를 발견했다. 해당 기록은 정식 비교에서 제외하고 요청 횟수·추정 비용만 별도 기록한다.
- 자유 산문 실험·블라인드 인간 평가·자동 모델 교체는 수행하지 않는다. 장면 선택 결과로 해당 품질을 대신 주장하지 않는다.

- 최종 검증: 14파일·91검사, core 검사(기존 경고 44개), 프로덕션 빌드, 모바일 3종/데스크톱 및 지도 지연·404·구버전, 로컬 PostgreSQL 마이그레이션 재적용 모두 통과했다.
- [모델 재평가](../../experiments/2026-09-28-learn-model-reevaluation.md): 추가 한도 검증과 미완료 반복 25건·미수집 인간 점수를 별도 표시했다. 소생·착지 등 고정 근거의 원본/보정 후 커버리지와 호출 오류를 구분했다. 운영 모델 변경 없음.
