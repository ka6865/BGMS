# 2026-10-14 프로젝트 점검 후속 조치

2026-10-14 읽기 전용 점검(코드, 운영 Supabase advisor·권한·로그, GitHub Actions 실행 이력, 브라우저 실측)에서 확인한 항목의 조치 기록이다.

## 1차 조치 (PR #257, 병합·배포 완료)

| 항목 | 조치 |
| --- | --- |
| `reports` public INSERT 정책(`with check true`)과 anon·authenticated INSERT 권한 | 정책 삭제, 권한 회수. 신고는 `app/api/board/report`의 service role 경로로만 저장 |
| `increment_likes` anon·authenticated 실행 가능(SECURITY DEFINER, 사용자 확인 없음) | 실행 권한을 service role로 제한 |
| 웹 게시글 추천이 브라우저에서 `post_likes` INSERT 후 `increment_likes` 호출 | `/api/board/posts/[postId]/likes`로 이관. 모바일과 같은 `recommend_mobile_board_post` 원자 RPC 사용 |
| 모바일 푸터 링크가 글자 단위로 세로 줄바꿈 | 링크 줄을 줄 단위 줄바꿈으로 변경 |
| 공개 API 9곳이 DB·내부 에러 원문을 응답 | 고정 문구로 통일, 원문은 서버 로그 |

### 운영 migration 적용 실적

- 대상: `20261014090000_restrict_public_board_writes`
- 순서: PR 병합 → Production 배포 확인(`POST /api/board/posts/1/likes` 비로그인 401) → migration 적용
- 방법: 임시 작업 폴더에 원격 이력 138개의 빈 자리표시 파일과 대상 파일 하나만 두고 `supabase db push --linked --workdir <임시 폴더>`. 적용 직전 `--dry-run`으로 대상이 그 파일 하나인지 확인했다.
- 적용 시각: 2026-10-13 21:03 UTC
- 적용 전후 확인

| 항목 | 적용 전 | 적용 후 |
| --- | --- | --- |
| `reports` 행 수 | 0 | 0 |
| `posts.likes` 합계 / `post_likes` 행 수 | 3 / 3 | 3 / 3 |
| anon·authenticated `reports` INSERT | true | false |
| anon·authenticated `increment_likes` EXECUTE | true | false |
| service role `reports` INSERT, `increment_likes` EXECUTE | true | true |
| `reports` 정책 | 2개 | `Allow admin manage reports` 1개 |

## 2차 조치 (PR #258, 병합·배포 완료)

| 항목 | 조치 |
| --- | --- |
| search_path 미고정 함수 7개(advisor `function_search_path_mutable`) | `search_path = public` 고정 |
| `get_db_size`, `handle_new_user` 등 앱이 쓰지 않는 anon·authenticated 실행 권한 | service role만 남김. `suggest_similar_players`는 당시 전적 검색 SSR 클라이언트가 호출해 실행 권한 유지(3차에서 회수) |
| 지도 필터 버튼, 게시판 이전·다음 페이지 링크에 접근성 이름 없음 | `aria-label` 추가 |
| 로컬 Node 버전 기준 없음 | `.nvmrc`(22, CI와 동일) |
| 환경 변수 목록 문서 없음 | `.env.example`(이름과 용도만) |

`20261014100000_pin_legacy_function_search_path`는 앱 코드 변경에 의존하지 않는다. `get_db_size` 호출부(관리자 대시보드, Admin Agent, 운영 스크립트)는 모두 service role을 쓴다. 적용 방법은 1차와 같다.

### 운영 migration 적용 실적

- 대상: `20261014100000_pin_legacy_function_search_path`, 적용 시각 2026-10-13 21:11 UTC(1차와 같은 방법, dry-run 대상 1개 확인)
- 7개 함수 모두 `search_path=public`. `suggest_similar_players`를 뺀 6개는 anon·authenticated EXECUTE false, service role true
- advisor: `function_search_path_mutable` 7건 → 0건, anon 실행 가능 SECURITY DEFINER 5개 → 2개(`increment_views`, `suggest_similar_players`)
- 익명 키 REST 확인: `get_db_size` 401(권한 거부), `suggest_similar_players` 200
- 적용 전 회원 512명·프로필 512개

## 3차 조치 (PR #259, 병합·배포 완료)

| 항목 | 조치 |
| --- | --- |
| `suggest_similar_players` 콜드 캐시 5.3초, anon statement timeout(약 3초)으로 PostgREST 500 | 기존 `nickname` GIN trgm 인덱스 조건(`%`)으로 후보 선택, 임계값 0.2는 함수 설정으로 고정, SECURITY INVOKER, 호출부를 service role로 옮기고 anon·authenticated 실행 권한 회수. 새 인덱스는 만들지 않음(pg_trgm trigram은 소문자화되어 `lower_nickname` 인덱스와 같은 결과) |
| `increment_views` anon 실행 가능(조회수 무제한 증가) | `/api/board/posts/[postId]/views`(service role) → `increment_board_post_views` 원자 RPC. 게시글 행 잠금 후 같은 게시글·같은 IP 해시는 1시간에 한 번만 셈, 공개 글만, 하루 지난 기록 정리. `increment_views` 실행 권한 회수 |
| 보조 텍스트 대비 부족 | 푸터 링크·고지문 8.13:1, 모바일 하단 내비 비활성 라벨 8.42:1, 게시판 빈 상태 문구, 1:1 비교 돌아가기 링크 개선(375·390·430·1440 실측) |
| 색상 토큰 미사용 | `globals.css` 토큰을 Tailwind 테마 색상으로 등록. 공통 헤더·내비·푸터·모달·게시판 일부의 `#F2A900` 등을 토큰 클래스로 교체 |

두 migration은 모두 앱 배포 후 적용한다. 먼저 적용하면 이전 앱의 닉네임 추천은 빈 목록, 조회수 증가는 실패(화면 영향 없음)로 처리된다.

### 운영 migration 적용 실적

- 2026-10-13 22:34 UTC `20261014110000_suggest_similar_players_trgm_index_scan` 적용 실패: `permission denied to set parameter "pg_trgm.similarity_threshold"`. 트랜잭션이 되돌려져 함수·권한·이력은 바뀌지 않았다. 격리 검증은 슈퍼유저로 실행되어 이 차이를 잡지 못했다.
  - 원인: 운영 migration 역할은 슈퍼유저가 아니고, pg_trgm 라이브러리가 로드되지 않은 세션에서는 이 설정을 정의되지 않은 값으로 보고 함수 설정으로 붙이지 못한다.
  - 비슈퍼유저 PostgreSQL 17 컨테이너에서 같은 에러를 재현했고, 함수 정의 전에 `similarity()`를 한 번 호출해 라이브러리를 로드하면 생성·재실행·호출이 모두 정상이며 세션 임계값도 바뀌지 않음을 확인했다.
  - 이 사이 앱은 service role로 기존 함수를 호출해 닉네임 추천은 계속 동작했다.
- 2026-10-13 22:35 UTC `20261014120000_protect_board_post_views` 적용. 배포 직후부터 적용 전까지 조회수 API는 503(조회수 미반영), 적용 직후 PostgREST 스키마 갱신 전 한 번 503, 이후 정상(없는 글 404). anon·authenticated의 `increment_views`, `increment_board_post_views` 실행 권한 false.
- 실패한 닉네임 추천 migration은 PR #260에서 `20261014130000_suggest_similar_players_trgm_index_scan`으로 번호를 바꿔 병합·운영 적용했다(`20261014110000`은 어느 환경에도 적용되지 않았다).
- 2026-10-14 이어받기 점검에서 운영 이력의 `20261014090000`, `20261014100000`, `20261014120000`, `20261014130000` 적용을 재확인했다. 닉네임 추천은 SECURITY INVOKER이며 `search_path=public`, `pg_trgm.similarity_threshold=0.2` 설정을 유지하고 service role만 실행할 수 있다. 익명 실행 가능 SECURITY DEFINER 함수는 0개다.

## 4차 보완 (브라우저 재현·회귀 검증)

| 항목 | 조치 |
| --- | --- |
| 비활성 게시판 화살표가 Tab으로 선택되고 Enter 클릭 이벤트를 발생시킴 | 375·390·430·1440px에서 재현. 첫 페이지의 이전·마지막 페이지의 다음은 `href` 없는 비활성 요소로 표시하며, 실제 Tab 이동과 활성 화살표의 페이지 전환을 검사 |
| 접근성 브라우저 fixture가 새 조회수 POST를 예상 밖 요청으로 처리 | 현재 게시글 bigint ID·랭킹 캐시 RPC 계약으로 fixture 갱신. 조회수 API 응답·화면의 조회수 2·sessionStorage 기록을 확인하고 기존 직접 `increment_views` 호출 허용 제거 |
| pg_trgm 선로드 정적 검사가 주석·문자열에도 통과 | 실행 문장만 인정하고, 격리 DB의 새 연결에서 NOSUPERUSER 소유자로 migration 전체 적용·재실행 및 service role 호출·권한 검증 |
| 추천 순서 검사가 반환 결과를 스스로 재정렬 | WITH ORDINALITY로 실제 반환 순서를 수집해 최소 두 결과의 모든 인접값 검사 |
| `reports`의 공개 TRUNCATE 권한 잔존 | `20261014140000_reports_revoke_public_truncate`에서 PUBLIC·anon·authenticated 권한만 회수. 기존 조회·관리자 수정·삭제와 service role 권한 유지. 외부 악용 경로가 확인된 항목은 아니며 예방 권한 정리 |
| 개발 도구의 `sprintf-js` 취약 의존 경로 | 기존 `js-yaml` 4.3.2를 override로 재사용해 구버전 YAML·argparse·esprima·sprintf 의존성 4개 제거. 실제 NYC YAML 설정 로딩과 Jest 커버리지 실행 확인 |

새 TRUNCATE 권한 migration은 격리 DB에서 최초·재실행과 권한 유지까지 검증한 뒤 운영에 적용했다. 2026-10-13 23:45 UTC 확인 결과 이력에 `20261014140000`이 추가됐고 PUBLIC·anon·authenticated TRUNCATE는 false, service role TRUNCATE와 기존 SELECT·UPDATE·DELETE 권한은 true다. 신고 행 수는 적용 전후 0행이다. 이 권한은 앱 호출 경로에서 쓰지 않아 앱 배포에 의존하지 않는다. 실제 TRUNCATE나 운영 데이터 삭제는 실행하지 않았다.

- 검증: `verify:core` 통과(에러 0, 기존 경고 45), `verify:admin` 420개, 전체 Vitest 4,117개, Jest 2개, 격리 migration 검증, 운영 의존성 감사 취약점 0건.
- 브라우저: 375×667, 390×844, 430×932, 1440×900의 키보드·화면·fixture 요청 검증 13개 통과. 웹 뷰포트 검증이며 실기기·실제 OAuth·운영 회원 데이터 쓰기는 포함하지 않는다.
- 검증 자체의 회귀 확인: 일회용 사본에서 pg_trgm 선로드를 제거하거나 추천을 오름차순으로 바꾸면 DB 검증이 실패함을 확인했다.
- 운영 적용 준비: 원격 이력 142개를 보존한 임시 폴더의 `db push --linked --dry-run` 대상이 `20261014140000_reports_revoke_public_truncate.sql` 한 개임을 확인했다. 운영 `reports`는 0행이며 이 migration은 데이터 변경 없이 공개 TRUNCATE 권한만 회수한다.
- 개발 의존성 전체 audit: `sprintf-js`에서 파생된 moderate 20건이 제거됐다. 남은 high 5건은 개발용 `braces` 한 개에서 파생된 경고다. [공식 공지](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)에 수정 버전이 없으며 운영 의존성 audit은 0건이다.

## 남은 항목

2026-10-15 재확인 기준이다.

- Daily BGMS Maintenance: 6·7차 보완 후 [2026-10-14 21:27 UTC 실행](https://github.com/ka6865/BGMS/actions/runs/38640356723)에서 모든 단계가 성공했다(2026-10-13 22:27 UTC 실행은 Run Storage Cleanup, Extract Bluezone Statistics, Backfill Unknown Match Types 실패). 해소.
- PUBG Archive Backlog·Detail Archive Retention(9차에서 재시도 추가, 병합 후 정기 실행으로 확인 필요): 6차 인덱스 이후 중단 사유가 `lock-budget-exceeded`에서 `retention-legacy-team-write-unverified:400:lock-unavailable`(잠금 획득 실패)로 바뀌었다. [2026-10-14 21:48 UTC 실행](https://github.com/ka6865/BGMS/actions/runs/38643016383)은 5개 배치에서 43개 객체(7,289,423바이트)를 정리한 뒤 6번째 배치에서 삭제 전 안전 중단했다. 정리는 진행되지만 실행마다 실패로 끝나므로, 잠금 경합 상대를 확인해야 한다.
- `suggest_similar_players`: 9차에서 두 단계 검색으로 줄였다(해소). 0.3 이상 결과가 limit 개 미만이라 0.2로 다시 찾는 검색은 콜드 캐시에서 약 0.7초가 남는다.
- RLS 성능 advisor(`auth.uid()` 행별 재평가 38건, 중복 permissive 정책 80건(이전 86건), 인덱스 없는 FK 36건), Auth 유출 비밀번호 보호 비활성. 2026-10-15 advisor 재조회 기준.
- 하드코딩 색상 82개 파일 1,112건 남음(공통 컴포넌트 일부만 교체). 푸터 링크 등 텍스트 링크 터치 영역 18px 높이.
- `pubg_api_errors` 정리 작업 없음: 9차에서 일일 정리 추가(해소). 병합 후 첫 일일 실행에서 30일 지난 약 5,600행이 삭제된다.

## 5차 보완 (조회 기록 개인정보)

| 항목 | 조치 |
| --- | --- |
| 조회 기록의 IP 해시가 비밀값 없는 SHA-256이라 IPv4 전수 대입으로 원래 IP 복원 가능 | 서버 전용 `SUPABASE_SERVICE_ROLE_KEY`를 키로 쓰는 HMAC-SHA256으로 변경. 새 환경 변수는 없다. 배포 직후 1시간 안에 다시 본 방문자는 한 번 더 집계될 수 있다 |
| 하루 지난 조회 기록이 그 게시글이 다시 집계될 때만 삭제됨 | daily-tasks의 `board-write-quota-cleanup` job에서 `scripts/cleanup_board_post_view_tracking.ts`로 24시간 지난 기록 전체 삭제. migration 변경 없음(service role DELETE 권한 기존 부여) |

- 배포 전 남은 비밀값 없는 해시 기록은 다음 정기 정리에서 24시간 기준으로 삭제된다.
- 2026-10-14 운영에서 정리 스크립트를 실행해 권한과 경로를 확인했다. 당시 16행 중 24시간 지난 행이 0행이라 삭제는 0행이었다.

## 6차 보완 (느린 쿼리)

운영에서 읽기 전용 `EXPLAIN ANALYZE`로 원인을 확정한 뒤 migration을 하나씩 적용했다.

| 대상 | 원인(실측) | 조치 | 결과 |
| --- | --- | --- | --- |
| 매치 유형 보정(`backfill_unknown_match_types.ts`) | `match_type='unknown'` 행이 0건이라 기존 인덱스 134만 행을 끝까지 훑음(20초) | `20261014160000` 부분 인덱스(CONCURRENTLY) | 0.1ms |
| 플레이어 캐시 정리(`compact_pubg_player_cache`) | 최근 15만 행 경계를 디스크 정렬(3.6초), 대상 수 계산이 OR 조건으로 본문을 읽음(4.2초), 2026-08-30 이후 자동 VACUUM 없음 | `161000` 경계 순서 인덱스, `162000` 대상 포함 인덱스, `163000` 자동 VACUUM 기준 5%, `164000` 중복 인덱스 삭제, `165000` OR 조건 분리(반환 계약·삭제 순서 동일) | dry-run 첫 호출 2.9초, 이후 0.3초 |

| Archive 정리 `recover_retention_legacy_team`(`lock-budget-exceeded`) | 6개 테이블 잠금 후 1초 예산 안의 확인 중 `pubg_match_performance`(match_id·platform·player_id) 조회가 기본키로 플랫폼 전체를 훑음(0.61초) | `166000` 조회 인덱스. 잠금 예산 1초는 유지 | 해당 조회 0.002초, 잠금 안 확인 전체 약 0.09초(디스크 읽기 포함) |

- 인덱스는 `CREATE/DROP INDEX CONCURRENTLY`로 만들어 운영 쓰기를 막지 않았다. Supabase CLI 2.105 `db push`에서 파일 단위로 적용됐다.
- Archive 정리 실패 전 배치 1~8은 배치마다 준비 객체 수와 삭제 수가 같았고(14·6·13·10·6·4·11·8, 합계 72), 되돌림이나 복구 실패 기록이 없었다. 9번째 배치는 삭제 전 보존 단계에서 멈췄다. 로컬에 R2 접속 정보가 없어 DB 포인터와 R2 객체의 전수 대조는 하지 않았다.
- 잠금 예산을 늘리면 그동안 6개 테이블 쓰기가 막히므로, 예산 대신 잠금 안의 조회를 빠르게 했다.
- 플레이어 캐시 정리 대상이 19.4만 행 밀려 있어 배치를 500행에서 1,000행으로 늘렸다. 한 실행 3만 행 상한은 유지한다(하루 최대 3만 행, 약 7일).

## 7차 보완 (자기장 업로드)

- 원인: 운영 Supabase Storage에 `app-data` 버킷이 없었다. 기존 데이터 읽기는 404를 허용해 저장소의 `public/bluezone_data_v2.json`(1,989건)으로 대신했고, 새 경기가 생겨 업로드를 시도한 2026-10-04부터 `bluezone-storage-upload-failed`로 실패했다. `/api/bluezone`도 같은 파일로 응답해 화면 데이터 손실은 없었다.
- 조치: `20261014170000_bluezone_app_data_bucket`으로 비공개 버킷(JSON만, 20MB) 생성. 운영에서 현재 1,989건 파일을 올리고 다시 읽어 확인했다. 업로드 실패 시 원인 메시지를 로그에 남긴다.

## 8차 보완 (유입 측정·광고·개인정보처리방침)

| 항목 | 조치 |
| --- | --- |
| `analytics_events.referrer_path`에 경로만 저장돼 외부 유입(검색·커뮤니티)을 구분할 수 없음 | 문서 로드 후 첫 `page_view`의 `params`에 `landing`, `referrer_host`(외부 도메인·`direct`·`internal`), `utm_source`·`utm_medium`·`utm_campaign`(100자)을 기록. 리퍼러 경로·검색어는 저장하지 않으며 migration 없음 (PR #279) |
| `/meta` 시험 페이지가 사이트맵에 남음(최근 30일 방문 0회) | 페이지 삭제, `/weapons`로 308 영구 이동, 사이트맵 제외. 대시보드 컴포넌트는 `/weapons`에서 계속 사용 (PR #279) |
| 카카오 애드핏 최근 28일 적립 49원(누적 4,917원, 지급 기준 5만원)인데 전적 상단·지도 하단 등 노출이 좋은 자리를 차지. 애드센스 `게시판 세로` 단위 하나를 게시판·랭킹·무기도감·전적 레일 5곳이 함께 써서 위치별 수익을 구분할 수 없음 | 애드핏 13곳을 위치별 애드센스 단위로 교체하고 `AdfitBanner` 삭제. 단위 ID 24개를 `lib/ads/adsenseUnits.ts`에 모으고 콘솔 이름을 주석으로 남김. `AdSenseBanner`에 고정 규격(`width`·`height`) 추가. 환경 변수로만 켜지던 `stats-after-10` 자리와 `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT` 제거. 지도 데스크톱 하단은 728x90 (PR #280) |
| 개인정보처리방침이 실제와 다름(이용 로그 1년→실제 30일, AI 캐시 90일→실제 30일). 파기 절차·안전성 확보 조치 절 없음. 애드센스 필수 고지·행태정보·국외 이전 미기재 | 2025-04 개정 작성지침과 법 제30조 항목으로 대조해 보완. 보유 기간을 정리 작업 기준으로 수정, 파기 절차(4-1)·국외 이전(7-1)·AI 분석 처리(7-2)·안전성 확보 조치(11절) 신설, 커뮤니티·디스코드 처리 항목, 법정대리인, 구제 기관 추가, 애드핏 안내 제거. 시행일 2026-10-15 (PR #280) |
| Gemini API를 무료 이용 조건으로 쓰는데 커뮤니티 자동 답변이 댓글 작성자 닉네임을 모델에 전송 | 모델 입력에서 작성자 닉네임 제외. 관리자 검토용 Discord 알림 표시는 유지. 방침 7-2에 무료 이용 조건(서비스 개선 사용, 검토자 확인 가능) 고지 (PR #282) |
| 개인정보처리방침의 4열 표가 375·390px에서 페이지 폭을 21·6px 늘림 | 페이지 폭을 고정하고 표 영역만 가로 스크롤 (PR #280) |

### 운영 콘솔 변경

- 애드센스(2026-10-15 03:47~03:51 KST): 디스플레이 광고 단위 21개 생성, 기존 3개 이름 변경(`전적피드`→`전적_목록중간_인피드`, `상자까 시뮬`→`상자깡_우측레일_세로`, `게시판 세로`→`게시판_좌측레일_세로`). 이름 규칙은 `페이지_위치_모양`. 단위는 총 24개다.
- 애드핏: 계정과 적립금은 그대로 두고 사이트 게재만 중단했다.
- 개인정보처리방침의 사실 확인: Supabase 프로젝트 리전 Northeast Asia(Seoul)(`supabase projects list`), 공개 테이블 96개 모두 RLS 사용, 탈퇴 시 게시글·댓글 `user_id`는 `SET NULL`, 정리 작업 보존 기간(이용 로그 30일, 수집 제한 기록 7일, 조회 IP 해시·작성 기록 24시간, AI 캐시 30일, 플레이어 캐시 90일).

### 검증

- PR #279: `verify:core`, 전체 Vitest 4,155개 통과. 로컬 `next dev --webpack`에서 `/meta` 308, 사이트맵 제외 확인.
- PR #280: `verify:core`(에러 0), 전체 Vitest 4,148개 통과, 새 `tests/adsense-units.test.ts`(단위 ID 중복 없음, 화면 코드에 애드핏·하드코딩 단위 ID 없음). 375·390·430·1440·1920px에서 상자깡·랭킹·무기도감·가방·게시판·지도의 광고 자리 규격과 가로 넘침 0, 개인정보처리방침 375·390·430·1440px 넘침 0. 개발 환경 자리표시자 기준이며 실제 광고 게재와 전적 화면 브라우저 하네스는 확인하지 않았다.
- PR #282: `verify:community` 264개 통과.
- 세 PR 모두 CI(verify, verify-migrations, 운영 의존성 audit, Vercel) 통과 후 병합했다.

### 이후 확인

- 애드센스 보고서의 광고 단위별 수익에 새 이름이 집계되는지 확인한다. 2026-10-15 조회 시점의 최근 30일 애드센스 수익은 $4.61, 페이지 RPM $0.66이며, 자동 광고(전면 50.8%, 앵커 19.1%, 페이지 내 15.6%)가 약 88%였다.
- 애드센스 지급 보류: 주소 확인 PIN 미입력, 은행 정보 미등록.
- 외부 유입 기록은 배포 후 아래 조회로 확인한다.

```sql
select params->>'referrer_host' as source, count(*) as sessions
from analytics_events
where event_name = 'page_view' and params->>'landing' = 'true'
  and created_at > now() - interval '7 days'
group by 1 order by 2 desc;
```

- Gemini를 유료로 전환하면 개인정보처리방침 7-2를 갱신한다.
- `pubg_api_errors` 30일 정리 작업 추가(남은 항목).

## 9차 보완 (남은 항목 1·2·5)

| 항목 | 원인 | 조치 |
| --- | --- | --- |
| `pubg_api_errors` 정리 작업 없음 | 개인정보처리방침은 30일 보관인데 삭제 작업이 없어 6,257행 중 5,587행이 30일 초과(2026-10-15) | `scripts/cleanup_pubg_api_errors.ts`를 daily-tasks의 `board-write-quota-cleanup` job에 추가. 읽는 코드는 모두 최근 7일 이내라 영향 없음. service role DELETE 권한과 `created_at` 인덱스 확인 (PR #287) |
| Archive 정리 `lock-unavailable` 반복 | `recover_retention_legacy_team`이 6개 테이블을 `NOWAIT`로 잠가, 5분 주기 수집(`bgms-pubg-collection`)의 쓰기와 겹치면 즉시 거절. 2026-10-14 실행은 22:00 수집 시작 직후 22:01:29에 중단. 호출부는 재시도 없이 실행 전체를 멈춤 | `lock-unavailable`(HTTP 400)일 때만 2·5·10초 뒤 같은 packet으로 최대 3번 재시도. 잠금 단계 거절은 쓰기가 없어 안전하고, 응답 유실·다른 사유는 기존처럼 중단. 서버 `NOWAIT`는 앱 쓰기를 막지 않도록 유지 (PR #289) |
| `suggest_similar_players` 콜드 캐시 지연 | 임계값 0.2에서 GIN 후보 1,040개를 재확인하려고 본 테이블 블록 976개를 디스크에서 읽음(1.1초) | 임계값 0.3으로 먼저 찾고 limit 개 미만일 때만 0.2로 다시 찾음. 0.3 이상은 항상 0.3 미만보다 앞서 결과가 같음. 본 테이블 블록 976→306, 560→275. GiST 거리순(KNN)은 인덱스 대부분(약 2,500페이지)을 읽어 제외 (PR #288) |

### 운영 migration 적용 실적

- 대상: `20261015010000_suggest_similar_players_two_stage`. 적용 시각 2026-10-15 01:29:27 UTC.
- 방법: 임시 작업 폴더에 원격 이력 160개의 빈 자리표시 파일과 대상 파일 하나를 두고 `supabase db push --linked --workdir <임시 폴더>`. 적용 직전 `--dry-run` 대상이 그 파일 하나임을 확인했다.
- 적용 후: 함수는 plpgsql·SECURITY INVOKER, 설정 `search_path=public`·`pg_trgm.similarity_threshold=0.3`, anon·authenticated 실행 false, service role true, 이력 최신 버전 `20261015010000`.
- service role PostgREST 호출로 확인: 검색어 5개의 상위 유사도가 적용 전 측정과 같다. 네트워크 왕복 약 70~90ms 기준으로 처음 찾는 steam 검색어는 410ms, 0.2로 다시 찾은 kakao 검색어는 701ms였다.

### 검증

- PR #287: 새 테스트와 `daily-tasks-workflow` 15개 통과.
- PR #288: 로컬 실험 DB(31만 행)에서 검색어 600개의 결과가 기존 함수와 모두 같음(0.2 대체 검색 56건 포함). `verify:migrations` 통과(NOSUPERUSER 두 번 적용, 0.2 대체 검색 시나리오, 세션 임계값 유지). 관련 Vitest 44개 통과.
- PR #289: 재시도·중단 조건 테스트 포함 82개 통과.
- 네 PR(#286~#289) 모두 CI 통과 후 병합. Archive 재시도와 오류 로그 삭제는 병합 후 정기 실행에서 확인한다.
