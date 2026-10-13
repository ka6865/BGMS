# 서비스 후속 점검 수정 — 2026-10-13 최종 검증

기준은 origin/main의 0a3fb3d186c0bd06866fb75a98a7c33b968ec148이다.
수정은 codex/remaining-review-fixes에서 진행하며 운영 DB와 R2에는 적용하지 않았다.
기존 작업 폴더의 미커밋 변경은 별도 worktree로 분리해 보존했다.

## 사용자와 관리자에게 달라지는 동작

| 상황 | 수정 후 동작 |
| --- | --- |
| 비회원 글·댓글 조회 | 삭제 비밀번호의 해시는 공개 조회에서 제외하고 서버 전용 테이블에 보관한다. 기존 비밀번호는 바꾸지 않는다. |
| 비회원 삭제 비밀번호 반복 입력 | IP별 글/댓글 각각 1분 5회 제한을 비밀번호 비교 전에 적용한다. 제한 저장소 장애 때는 삭제를 중단한다. |
| 비회원 게시글 삭제 | 게시글 삭제와 댓글·좋아요·삭제 비밀번호 정리를 DB의 기존 cascade로 함께 처리한다. 게시글 삭제 실패 때 댓글만 먼저 지우지 않는다. |
| 차량 위치 제보 | 로그인한 사용자, 지도, 현재 활성 종류와 좌표를 서버에서 확인한다. 근처 20m 동일 종류 제보가 있으면 기존 안내를 유지한다. |
| 차량 제보 투표 | 여러 사용자가 동시에 투표해도 모든 표를 보존한다. 일반 사용자의 중복 투표는 막고 관리자의 기존 반복 투표 권한은 유지한다. |
| 오래 열린 제보 창 | 기존 INSERT는 본인 기여자·초기 표 1개·기본 알림 상태·유효 좌표로만 허용한다. 임의 점수 변경과 직접 UPDATE는 차단한다. |
| 핫드롭 수집 | 기존 누적 수에 새 수를 더한다. 저장 RPC 실패 때 이전 누적 수를 새 수로 덮어쓰지 않는다. |
| 관리자의 권한·PUBG 프로필 저장 | 전용 RPC로 함께 저장한다. 기존 일반 사용자의 관리자 자가 승격 방지는 유지한다. 전달하지 않은 필드는 보존한다. |
| 관리자의 매치 캐시 삭제 | DB 실패 때 Storage 삭제를 실행하지 않는다. DB만 성공하면 부분 완료 경고를 표시하고 매치 ID를 유지해 재시도할 수 있게 한다. |
| 백업·복원 | 삭제 비밀번호 전용 테이블도 백업한다. 최신 migration 적용과 gzip 백업의 격리 DB 복원을 검사한다. |
| 현재 시즌 모드·인원 선택 | 경쟁전·일반전, 솔로·듀오·스쿼드 버튼의 클릭 영역을 최소 44px로 키운다. 선택 기능과 데이터는 유지한다. |

점수 계산식, 과거 전적 데이터와 랭킹 캐시 동작은 바꾸지 않는다.
기존 계산 결과를 보존하고 새 분석에 새 버전을 사용하는 계약을 회귀 검사한다.
관리자 캐시 삭제의 부분 실패 안내와 현재 시즌 선택 버튼의 클릭 영역이 바뀐다.
PC 첫 화면에 모든 전적 정보를 표시하도록 페이지를 재배치하지 않는다.

## 운영 전환 순서

아래는 코드 검증과 구분된 운영 실행 절차다. main 병합은 Vercel Production 배포를 바로 시작하므로
1~3단계는 PR 병합 전에 끝낸다. migration은 병합으로 자동 적용되지 않는다.

`npm run db:backup`(R2 핵심 테이블 백업)은 2026-10-09부터 `pubg_player_matches` 20만 행 한도 초과와
`pubg_match_performance` 조회 timeout으로 실패하고 있어 이번 전환의 백업 수단으로 쓰지 않는다(별도 PR에서 수정).
대신 전환 대상 테이블만 논리 백업하고 격리 DB에서 복원까지 확인한다.

### 백업 대상

전환·배포 확인에서 바뀔 수 있는 테이블과, 그 행이 외래키로 참조하는 부모 테이블까지 포함한다.
부분 덤프는 의존 객체가 빠질 수 있으므로 파일 생성이 아니라 격리 복원 성공으로 판단한다.

- 직접 대상: `posts`, `comments`, `post_likes`, `pending_markers`, `profiles`, `board_write_rate_limits`, `hotdrop_heatmap`
- `posts` 삭제 CASCADE 대상: `board_post_image_refs`, `notifications`
- 외래키 부모: `board_image_objects`(`board_post_image_refs.image_id`), `support_messages`, `support_tickets`(`notifications`)
- 준비 migration 이후 추가: `board_post_delete_credentials`, `board_comment_delete_credentials`

`profiles`와 `board_image_objects`는 `auth.users`를 참조한다. auth 스키마는 Supabase가 관리하는 개인정보이므로
덤프하지 않는다. 운영 DB에 대한 부분 복구에서는 기존 `auth.users`가 그대로 있으므로 문제가 없고,
격리 검증에서는 ID만 가진 `auth.users` 행을 만들어 외래키를 검사한다.

### 백업 명령

백업 파일은 개인정보와 비밀번호 해시를 포함하므로 저장소에 넣지 않고 권한 700 폴더(예: `~/bgms-archive/<날짜>/`)에 둔다.
`supabase db dump`는 Docker와 `supabase link`가 필요하며 운영 DB를 읽기만 한다.

```bash
# 스키마 전체(함수·트리거·정책·권한 포함)
supabase db dump --linked -f "$BACKUP_DIR/prod-schema.sql"
# 대상 테이블 데이터만: 백업 대상을 제외한 public 테이블을 모두 -x 로 뺀다
supabase db dump --linked --data-only --use-copy -s public -x public.<제외 테이블> ... -f "$BACKUP_DIR/target-data.sql"
```

데이터 덤프는 `SET session_replication_role = replica`로 시작해 복원 중 외래키 검사를 끈다.
그래서 복원 후 외래키 고아 행을 별도로 검사한다. 덤프에는 대상 밖 시퀀스의 `setval`도 섞일 수 있으므로
운영 DB에 직접 되돌릴 때는 격리 DB에 먼저 복원한 뒤 필요한 행·시퀀스만 옮긴다.

### 격리 복원 검증

운영과 같은 Supabase Postgres 이미지로 일회용 컨테이너를 띄워(`127.0.0.1` 전용) 다음을 확인한다.

1. 이미지 기본 권한(`ALTER DEFAULT PRIVILEGES`)을 비운 뒤 스키마를 적용한다. 비우지 않으면 복원된 테이블·함수에
   anon/authenticated 권한이 덧붙어 운영보다 넓어진다. 새 Supabase 프로젝트로 재해 복구할 때도 같은 확인이 필요하다.
2. 데이터를 복원하고 운영 PostgREST 읽기 결과와 테이블별 행 수·내용 해시를 대조한다. 값은 출력하지 않는다.
   방문 중 바뀌는 `posts.views`는 해시에서 빼고 차이만 보고한다.
3. 대상 테이블에 걸린 외래키 전체의 고아 행이 0인지, identity·serial 시퀀스가 최대 ID 이상인지 확인한다.
4. 대상 테이블과 전환 관련 함수의 anon/authenticated/service_role 권한이 스키마 덤프와 같은지 확인한다.
5. 복원본 위에서 준비 migration 4개와 활성화 migration을 리허설하고 아래 확인 항목을 실행한다.

### 전환 순서

1. **전환 전 백업**: 관리형 일일 물리 백업이 최근 날짜로 COMPLETED인지 확인하고(`supabase backups list`),
   위 명령으로 대상 테이블 논리 백업을 만든 뒤 격리 복원 검증을 통과시킨다.
2. **준비 migration 4개를 파일명 순서로 하나씩 적용**한다. `supabase db push`는 쓰지 않는다
   (원격 이력 3개와 로컬 파일의 시간 식별자가 달라 중단되고, 일괄 적용하면 활성화 migration까지 먼저 들어간다).
   SQL Editor 또는 `psql -v ON_ERROR_STOP=1 -f <파일>`로 적용하고, 적용 후 `supabase migration repair --status applied <버전> --linked`로 이력만 기록한다.
   daily-tasks의 핫드롭 수집 시간(21:00~00:30 UTC)은 피한다.
   - 20261010112340_protect_board_delete_credentials.sql
   - 20261010112343_secure_pending_marker_writes.sql
   - 20261010112345_repair_hotdrop_atomic_counts.sql
   - 20261010113347_admin_profile_save.sql
3. **준비 후 백업**: 비밀번호 전용 테이블 2개를 백업 대상에 더해 같은 방식으로 다시 백업하고 격리 복원 검증을 통과시킨다.
   전용 테이블 행 수가 공개 `password_hash`가 있는 글·댓글 수와 같은지 확인한다. 이 백업을 확인한 다음 PR을 병합한다.
4. **PR 병합 = 새 앱 Production 자동 배포.** 기존 글·댓글 삭제, 제보 등록·투표, 관리자 저장, 캐시 부분 실패 응답을 확인한다.
   Preview와 Production이 같은 DB를 쓰므로 쓰기 확인은 정리 방법을 정한 테스트 데이터로만 한다.
5. 새 삭제 API가 배포된 것을 확인한 뒤에만 20261010113427_activate_board_delete_credential_privacy.sql을 적용한다.
6. 공개 글·댓글의 password_hash가 NULL이고 서버 전용 해시가 보존됐는지 확인한다. 기존 비밀번호 삭제와 새 비회원 작성·삭제를 재확인한다.

### 준비 migration 적용 후 확인 항목

| migration | 확인 |
| --- | --- |
| protect_board_delete_credentials | 전용 테이블 2개 RLS 활성, anon/authenticated SELECT 불가 / 전용 테이블 행 수 = 공개 해시가 있는 글·댓글 수, 해시 값 동일 / 공개 `password_hash` 그대로 유지 / 할당량 제약에 `post_delete`, `comment_delete` 포함 |
| secure_pending_marker_writes | `pending_markers` UPDATE 정책 0개, INSERT 정책은 `pending_markers_safe_legacy_insert` 1개 / authenticated UPDATE 권한 없음 / `create_pending_marker`, `vote_pending_marker`는 service_role만 실행 / 종류 검사 보조 함수 `pending_marker_category_allowed`는 기존 제보 창을 위해 authenticated 실행 가능, anon 불가 |
| repair_hotdrop_atomic_counts | `upsert_hotdrop_counts`는 `(rows text)` 하나만 남고 SECURITY DEFINER, service_role만 실행 / `hotdrop_heatmap` 행 수·count 합계 불변 |
| admin_profile_save | `save_admin_profile`은 service_role만 실행 / 역할 변경 트리거 유지 / 관리자 수 불변 |
| 공통 | `supabase migration list --linked`에 4개 추가, 활성화 migration 미적용 |

운영 스키마 확인 결과 `upsert_hotdrop_counts`는 `(rows json)`과 `(rows text)` 두 overload가 모두 anon/authenticated에
실행 권한을 갖고 있다(SECURITY DEFINER). repair_hotdrop_atomic_counts가 json overload를 제거하고 text overload의
권한을 service_role로 좁히므로, 이 migration 적용 전까지 익명 호출로 핫드롭 수치를 쓸 수 있는 상태가 유지된다.

### 2026-10-13 전환 전 백업 실적

- 스키마 덤프와 대상 12개 테이블 데이터 덤프를 권한 700 로컬 보관 폴더에 저장했다(저장소 밖).
- Supabase Postgres 17.6 일회용 컨테이너 복원: 12개 테이블 행 수·내용 해시가 운영과 일치(`posts.views` 2행만 덤프 후 조회로 증가),
  외래키 28개 고아 행 0, 시퀀스 5개 정상, 테이블 권한 28쌍·함수 권한 7쌍이 덤프와 일치.
- 같은 복원본에서 준비 migration 4개 → 기존 제보 창 INSERT(authenticated) → 활성화 migration → 전용 테이블 덤프·재복원까지 통과했다.
- 관리형 일일 물리 백업은 최근 7개가 COMPLETED(최신 2026-10-12 17:16 UTC)이다. PITR 사용 여부는 확인하지 않았다.

활성화 migration을 포함한 전체 migration을 새 앱보다 먼저 일괄 적용하면 예전 삭제 API가 비밀번호를 찾지 못한다.
운영에서 2단계와 4단계를 분리해야 한다. 준비 단계는 기존 비밀번호 열을 유지하고 복사 저장하며,
활성화 단계는 쓰기 잠금 아래 최종 복사 후 공개 열을 NULL로 바꾼다. 열 자체를 제거하지 않아 기존 SELECT *도 동작한다.

활성화 후 앱을 되돌릴 때에는 서버 전용 비밀번호 읽기를 지원하는 버전으로만 되돌린다.
공개 비밀번호를 복원하는 롤백은 정보 노출을 재발시키므로 사용하지 않는다.
제보 정책은 준비 단계부터 직접 UPDATE를 막는다. 기존 투표 API도 service_role을 사용해 계속 동작한다.
전환 전 복구 지점과 준비 직후의 새 완전 백업을 모두 확보한다. 전용 비밀번호 테이블이 없는 DB에는 새 백업 실행을 앞당기지 않는다.

## 검증과 리뷰

2026-10-13 기준으로 새 worktree의 실제 코드와 독립 설치 환경에서 검증했다.

| 검증 | 결과 |
| --- | --- |
| npm run verify:core | 오류 0, 기존 경고 45, TypeScript 통과 |
| npm run test:unit -- --maxWorkers=4 | 335개 파일·4,063개 검사 통과, 조건부 검사 100개 건너뜀 |
| npm test -- --runInBand | Jest 2개 검사 통과 |
| npm run build | Next.js 16.3.8 기본 Turbopack 배포 빌드 통과 |
| 격리 verify:migrations | 비밀번호 보존·공개 접근 차단·삭제 cascade·동시 투표·레거시/서버 근접 등록 직렬화·핫드롭 누적·관리자 저장 통과 |
| 격리 verify:baseline | baseline과 이후 최신 migration 적용 통과 |
| 격리 gzip 백업 roundtrip | 89개 migration 적용, 15개 테이블 검증, 7개 복원, 8개 빈 테이블 확인 |
| 전적 fixture 개발 서버 | 광고 feed 설정을 켠 상태에서 49개 브라우저 검사 통과 |
| 전적 fixture 배포 번들 | 광고 feed 설정을 끈 상태에서 49개 브라우저 검사 통과, 광고 OFF 왕복 resize 2개 별도 통과 |

모바일은 375x667, 390x844, 430x932의 레이아웃과 390x844의 기능 흐름을 확인했다.
PC는 1440x900의 기능 흐름과 1600px·1920px 등을 포함한 레이아웃/스크린샷을 확인했다.
조건부 건너뜀에는 브라우저 검사가 포함돼 있으며, 위 브라우저 49개는 별도로 실행했다.
실제 외부 AI·OAuth·광고 응답·모바일 앱 검증을 통과했다고 해석하지 않는다.

독립 리뷰의 제보 레거시 INSERT 우회, 백업 fixture 범위 누락,
광고 설정별 검사와 백업 전환 순서 지적을 보완하고 재검토했다.
최종 검토 범위에서 미해결 P1/P2는 발견하지 못했다.
최종 빌드에서 발견한 라우트의 테스트용 export와 GET 인자 형식도 정리했다.
매치 404 캐시 키·6시간 유효 기간·2,000개 제한, 무기 메타 계산과 응답은 그대로다.
백업 roundtrip은 15개 테이블의 본문·메타데이터 명단과 행 수를 검증한 뒤,
데이터가 있는 7개 fixture 테이블을 복원하고 나머지 8개가 빈 배열인지 확인한다.
복원 목록 밖에 데이터가 있으면 실패한다. 운영 전체 데이터 복원을 수행했다는 의미는 아니다.

전적 브라우저 검증에서 기존 dev server를 재사용할 때는 서버와 테스트 프로세스의
`NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT` 값을 동일하게 둔다. 첫 번째 명령은 서버 터미널에서, 두 번째는 테스트 터미널에서 실행한다:

```bash
NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT=DAN-fixture-stats-feed-728 npm run dev
```

```bash
NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT=DAN-fixture-stats-feed-728 RUN_STATS_BROWSER_SMOKE=true STATS_BASE_URL=http://127.0.0.1:3000 npx vitest run tests/stats-browser-smoke.test.ts
```

배포 번들을 로컬에서 검사할 때에는 공개 환경값을 build/start 단계와 테스트에 일치시킨다.
이 작업의 build/start에는 실제 DB 대신 격리용 localhost URL과 가짜 키를 사용했다.
이 로컬 산출물을 운영으로 배포하지 않는다. 광고 OFF 배포 번들 검사의 테스트 명령은 다음과 같다:

```bash
NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT= STATS_SERVER_MODE=production RUN_STATS_BROWSER_SMOKE=true STATS_BASE_URL=http://127.0.0.1:3227 npx vitest run tests/stats-browser-smoke.test.ts
```

개발 모드는 외부 광고 요청이 0건이어야 한다. 배포 모드는 광고 초기화 요청이 발생하되
fixture가 전부 차단한 상태인지 확인한다. 실제 광고 태그는 중복되지 않고,
광고 영역의 직접 소유자는 1개인지 확인한다.

## 의존성 감사

개발 도구가 사용하는 Handlebars는 4.7.9에서 4.7.10으로 고정해 패치했다.
Next.js, React, Jest의 주 버전을 바꾸거나 감사 도구가 제안한 과거 버전으로 낮추지 않았다.
실행용 의존성 감사는 0건이며, 전체 감사에는 개발용 25건(높음 5, 중간 20)이 남았다.
전이 의존성 경고가 포함된 개수이며 악용 불가를 증명한 결과는 아니다.
[braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)와
[sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)의 패치 미제공과
범위를 벗어나는 Jest/Next 개발 도구 하향 제안은 적용하지 않았다.

## 별도 운영 확인

실제 운영 DB/R2 복구, 외부 Discord 알림 전송, 실제 로그인 공급자·Gemini 호출,
실제 iOS/Android 앱·실기기 동작은 이번 격리 검증에 포함하지 않는다.
브라우저 viewport 검사와 실제 모바일 기기 검사를 구분한다.
R2 백업 보관 기간은 외부 lifecycle 설정이므로 이번 코드 변경으로 설정됐다고 단정하지 않는다.
