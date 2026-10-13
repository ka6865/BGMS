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

## 2차 조치 (이 문서와 같은 PR)

| 항목 | 조치 |
| --- | --- |
| search_path 미고정 함수 7개(advisor `function_search_path_mutable`) | `search_path = public` 고정 |
| `get_db_size`, `handle_new_user` 등 앱이 쓰지 않는 anon·authenticated 실행 권한 | service role만 남김. `suggest_similar_players`는 전적 검색 SSR 클라이언트가 호출하므로 실행 권한 유지 |
| 지도 필터 버튼, 게시판 이전·다음 페이지 링크에 접근성 이름 없음 | `aria-label` 추가 |
| 로컬 Node 버전 기준 없음 | `.nvmrc`(22, CI와 동일) |
| 환경 변수 목록 문서 없음 | `.env.example`(이름과 용도만) |

`20261014100000_pin_legacy_function_search_path`는 앱 코드 변경에 의존하지 않는다. `get_db_size` 호출부(관리자 대시보드, Admin Agent, 운영 스크립트)는 모두 service role을 쓴다. 적용 방법은 1차와 같다.

## 남은 항목

- Daily BGMS Maintenance: 핵심 백업이 `pubg_player_matches`에서 미완료로 4회 연속 실패. #256(백업 병렬 읽기) 이후 정기 실행 결과 확인 필요. 같은 실행의 `bluezone-storage-upload-failed`, 스크래퍼 5건 실패는 별도 원인.
- PUBG Archive Backlog·Detail Archive Retention: `retention-legacy-team-write-unverified:400:lock-budget-exceeded`로 반복 중단. 삭제 전 안전 중단이라 손실은 없으나 정리가 진행되지 않음.
- `suggest_similar_players` statement timeout: GIN 인덱스는 `nickname`, 함수는 `lower_nickname`에 `similarity()`를 걸어 전체 스캔. `nickname % 검색어`로 바꾸면 운영 EXPLAIN 기준 5.3초에서 3.0초로 줄지만 여전히 느려 별도 설계가 필요.
- `increment_views`는 anon 실행 가능(조회수 부풀리기 가능, 영향 낮음).
- RLS 성능 advisor(`auth.uid()` 행별 재평가 38건, 중복 permissive 정책 86건, 인덱스 없는 FK 36건), Auth 유출 비밀번호 보호 비활성.
- 하드코딩 색상 83개 파일 1,141건, 보조 텍스트 대비 부족(푸터 고지문 1.88:1 등).
