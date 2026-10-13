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
- 실패한 닉네임 추천 migration은 `20261014120000` 뒤로 순서를 맞추기 위해 `20261014130000_suggest_similar_players_trgm_index_scan`으로 번호를 바꿔 다시 적용한다(`20261014110000`은 어느 환경에도 적용되지 않았다).

## 남은 항목

- Daily BGMS Maintenance: 핵심 백업이 `pubg_player_matches`에서 미완료로 4회 연속 실패. #256(백업 병렬 읽기) 이후 정기 실행 결과 확인 필요. 같은 실행의 `bluezone-storage-upload-failed`, 스크래퍼 5건 실패는 별도 원인.
- PUBG Archive Backlog·Detail Archive Retention: `retention-legacy-team-write-unverified:400:lock-budget-exceeded`로 반복 중단. 삭제 전 안전 중단이라 손실은 없으나 정리가 진행되지 않음.
- `suggest_similar_players`: 인덱스 조건으로 바꾼 뒤에도 콜드 캐시 기준 약 3초(운영 EXPLAIN). service role 호출이라 timeout은 피하지만, 더 줄이려면 후보 수를 줄이는 별도 설계가 필요.
- RLS 성능 advisor(`auth.uid()` 행별 재평가 38건, 중복 permissive 정책 86건, 인덱스 없는 FK 36건), Auth 유출 비밀번호 보호 비활성.
- 하드코딩 색상 82개 파일 1,112건 남음(공통 컴포넌트 일부만 교체). 푸터 링크 등 텍스트 링크 터치 영역 18px 높이.
