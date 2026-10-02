# 전날 우승 경기 복기 운영

`/learn`은 KST 전날 검증된 Steam 경쟁전 우승 복기를 모드별로 보여준다. 솔로·듀오·스쿼드 각각의 행을 저장할 수 있지만, 세 모드가 매일 모두 존재한다고 보장하지 않는다. 신규 PK는 `(day_kst, mode)`이며 `match_id` 중복도 금지한다. 기록이 없으면 그 날짜의 공개 분석이 없다고 표시하고, 근거 없는 미지원·수집 실패를 추정하지 않는다. 공식적으로 지원되지 않는 AS Solo Ranked는 아래와 같이 명시적 `unsupported`로 보고한다.

### AS 솔로 Ranked 지원 범위

PUBG 공식 안내에 따르면 Season 36부터 AS 지역 Solo Ranked가 제거됐고 Duo Ranked가 전 지역에 추가됐다. 같은 시즌부터 Duo/Squad 및 FPP/TPP 간 RP도 통합됐다([Season 36 Ranked 변경](https://www.pubg.com/en/news/8722)). Update 40.1의 지역 큐 변경은 RU Duo/Squad TPP 추가와 NA·SA Squad FPP 제거를 기록하며 AS Solo 재도입을 공지하지 않는다([Update 40.1](https://www.pubg.com/en/news/9690)). 따라서 일일 AS 솔로 Ranked 우승 복기는 운영상 보장할 수 없다. Normal Solo나 다른 모드의 승리를 솔로 Ranked로 대체하지 않는다. 리더보드 순위는 조회 출처의 provenance이며, 통합 RP와 동일 명단이 관측될 수 있으므로 모드별 순위의 증거로 해석하지 않는다.

발행기의 기본 `all`은 AS 지원 큐인 Duo와 Squad만 처리한다. 명시적 `--mode=solo`는 `unsupported` 결과(`ranked_queue_unavailable_in_region`)로 즉시 건너뛰며 exit code 0으로 종료하고 DB, PUBG API, AI를 호출하지 않는다. 기존 저장된 Solo 행은 모드 타입과 조회 경로에 그대로 남고, 이 변경은 과거 행을 변환하거나 삭제하지 않는다. 공식 문서에 따라 AS Solo Ranked가 지원되지 않는 것으로 취급하며 Normal Solo나 다른 모드의 경기를 대체 발행하지 않는다. Duo/Squad 리더보드 fallback은 두 지원 큐 사이에서만 수행하고, 매치의 실제 `gameMode`는 요청 모드와 계속 정확히 일치해야 한다. `no_verified_candidate`는 지원 모드의 제한된 탐색에서 검증 승리를 얻지 못했다는 뜻이지, 해당 날짜의 모든 경기 부재를 증명하지 않는다.

## 발행과 재시도

GitHub Actions `daily-ranker-story.yml`은 매일 09:37·12:37 KST에 미발행 모드를 순회한다. 이미 발행된 모드는 보존하고, 일반 실패는 다른 모드로 진행한다. 공유 API 429는 이후 호출을 중단한다. 수동 실행은 `day_kst`와 `mode=all|solo|duo|squad`를 지정한다.

```sh
npx tsx scripts/publish_daily_ranker_story.ts --day=YYYY-MM-DD --mode=duo
# DB 저장이 필요한 경우에만 --apply 추가. 미리보기도 원본/모델 호출 비용은 발생한다.
```

필요한 환경값은 `PUBG_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`다. 키는 서버에서만 사용한다. 원본 텔레메트리는 매치가 연결한 검증된 URL에서만 받는다.

현재 시즌 AS 리더보드 상위 20명과 선수당 최근 14일 내 최대 32개 경기 참조를 탐색한다([PUBG 공식 문서](https://documentation.pubg.com/en/getting-started.html)). 모드 리더보드가 없으면 다른 조회 가능한 명단을 사용하되 실제 경기 모드는 매치 응답으로 검증하고 리더보드 출처를 저장한다. 매치 유형, 커스텀 여부, KST 경기일, 우승 계정, 텔레메트리 매치 ID, 개인·팀 킬 수를 대조한다. 실행의 요청 캐시와 12분 탐색 예산을 공유한다. 최대 3개 검증 후보 중 장면 종류와 최근 7일 선수·맵 반복을 기준으로 정렬한 뒤 AI를 호출한다.

## 근거와 공개 내용

`buildDailyEvidence` v5는 모든 근거에 제공된 원본 이벤트 배열의 인덱스를 보관한다. 피해·발사·기절·처치·소생·획득을 구분하며 팀 ID와 주체를 기록한다. 재착지·자기장 관측의 ID는 중복되지 않는다. 무기 획득을 실제 사용으로, 마지막 아군 처치를 경기 종료로 바꾸지 않는다. `LogMatchEnd`의 대상 선수 1위 기록으로 종료 장면을 만든다.

운영과 비교 실행기는 `buildDailyModelInput`을 공유한다. 전체 `facts`와 명단·교전·위치·자기장·장면 후보를 입력한다. AI는 3~5개 장면 ID만 선택한다. 공개 상황·행동·결과는 검증된 근거에서 코드로 생성하며, 보완·대체가 있으면 `selection.usedFallback`과 거절 사유를 저장한다. 실제 관측 시각을 표시하고 표본 사이 점선을 정확한 이동 경로로 표현하지 않는다. 근거가 없는 시야·엄폐·의도·승리 인과관계는 생성하지 않는다.

신규 글은 `schemaVersion=2`, `evidenceVersion=5`, 프롬프트 버전, 장면 수, 리더보드 조회 시각·시즌·출처를 함께 저장한다. 열람 시 원본이나 모델을 호출하지 않는다. 순위는 경기 당시 순위를 뜻하지 않는다. 기존 글에 없는 조회 시각을 발행 시각으로 대신 채우지 않는다.

## URL과 적용 순서

- 신규 상세: `/learn/daily/YYYY-MM-DD/solo|duo|squad`.
- 기존 날짜 URL: 한 편이면 해당 모드로 이동하고 여러 편이면 모드를 선택한다.
- 기존 JSON과 고정 샘플은 이전 상세 화면으로 계속 읽는다.
- 지도 로딩·이미지 실패 시에도 저장된 장면 해설을 읽을 수 있다.

운영 적용 전 `20260927145237_daily_ranker_stories_by_mode.sql`을 먼저 적용해야 한다. 이번 작업에서는 운영 DB에 적용하지 않았다. 로컬 임시 PostgreSQL에서 기존 행 보존, 3개 모드 저장, 날짜·모드/매치 중복 거절, 재적용, RLS와 권한을 검증했다. 테이블은 공개 클라이언트가 직접 읽지 않으며 서버의 service role만 select/insert한다. 관련 [Supabase Data API 권한 설명](https://supabase.com/docs/guides/api/securing-your-api)을 따랐다.

롤백은 우선 발행 워크플로를 중단하고 이전 앱을 복구한다. 같은 날짜에 여러 모드가 저장된 뒤에는 단일 날짜 PK로 되돌릴 수 없으므로 데이터 삭제 없는 스키마 유지가 안전하다.

## 모델 재평가

[지난 비교의 입력 누락 정정](experiments/2026-09-24-gemini-flash-comparison.md)과 [새 평가 기록](experiments/2026-09-28-learn-model-reevaluation.md)을 구분한다. 모델 변경은 자동 적용하지 않는다.

```sh
npx tsx scripts/compare_daily_models.ts --manifest=PATH --models=gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.7-flash,gemini-3.8-flash --runs=3 --output=PATH.jsonl
# dry-run의 누락 근거와 호출 수를 확인한 뒤 --run 추가
```

manifest는 원본 매치·텔레메트리의 SHA-256과 검토한 필수 근거 묶음을 지정한다. 모든 시도는 JSONL에, 재시도·대기 포함 총 지연은 `.summary.jsonl`에 기록한다. 입력 누락, 호출 불가 모델, 형식 오류, fallback을 성공으로 합산하지 않는다. 자유 해설의 사실 정확성·사람의 가독성 평가는 장면 ID 선택 결과로 대신하지 않는다.

## 경기 흐름 UI

장면이 저장된 상세 글은 `buildDailyWalkthrough`의 제목·전체 경기 요약·시간순 구간과 최대 3개 점검 항목을 표시한다. 저장 장면이 없는 글은 기존 상세를 유지한다. 모바일은 해설과 가로 구간 선택을 먼저 보여주며, 선택 구간/전체 동선 전환과 표시한 원의 공개 시각을 함께 안내한다. 원본 이벤트·지도 관측 상세·순위 출처는 기본 접힘이고, 장면 이동과 지도 버튼은 44px 이상의 터치 영역을 제공한다.
