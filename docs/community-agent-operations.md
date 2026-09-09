# BGMS 커뮤니티 비서 운영 절차

2026-09-09 관리자 상태 조회 오류를 복구하면서 연결된 Supabase에 `community_agent_persistence` migration을 적용했다. 원격 migration version은 `20260909061622`, 적용 SQL 원본은 `20260908000000_community_agent_persistence.sql`이다. 정책·출처·최근 실행 조회가 정상이며 수집과 자동 게시는 모두 꺼져 있다. 운영 앱 배포, GitHub Actions 활성화, 비서 계정 생성, 실제 자료 수집·게시는 아직 실행하지 않았다. 서버만 게시를 담당하며 외부 디시인사이드·네이버 카페·YouTube에는 글이나 댓글을 작성하지 않는다.

## 설정 위치

| 위치 | 설정 |
| --- | --- |
| 서버 | 기존 Supabase/Gemini 환경, `COMMUNITY_AGENT_WORKER_SECRET`, 선택적 `COMMUNITY_AGENT_MODEL`, `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`, `YOUTUBE_DATA_API_KEY` |
| GitHub Actions | secret `COMMUNITY_AGENT_WORKER_SECRET`; vars `APP_URL`, `COMMUNITY_AGENT_SCHEDULE_ENABLED`(기본 `false`) |
| DB 정책 | `enabled=false`, `publishing_enabled=false`, YouTube 출처 선택 해제로 배포 |

네이버 카페 검색은 Naver API HUB의 `https://naverapihub.apigw.ntruss.com/search/v1/cafearticle?format=json` 엔드포인트를 사용한다. 서버 환경 변수 이름은 기존 `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`를 유지하되 요청 헤더에는 각각 `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY`를 사용한다. 키 값은 URL이나 로그에 기록하지 않는다.

제공자 키가 존재한다는 사실만으로 활성화 준비가 끝난 것은 아니다. 배포 런타임, 무료 한도, 접근 조건, 보관 조건을 각각 확인한 뒤 출처를 켠다.

## 최초 적용과 활성화

1. `npm run verify:community`, `bash scripts/verify_community_agent_migration.sh`, `npm run verify:admin`, `npm run verify:core`, `git diff --check` 결과를 저장한다. migration은 커뮤니티 비서 전용 네 테이블과 service-role 전용 RPC를 추가한다. 기존 이용자 게시글·댓글을 삭제하지 않는다.
2. 운영 적용 전 migration 상태와 `write_board_post_with_images`의 존재 및 현재 서명을 확인한다. 운영 DB 변경과 배포에 대한 기존 승인이 없다면 적용 SQL, 영향, 검증 결과를 제시하고 최종 승인을 받는다.
3. 배포 환경의 함수 실행시간, Gemini 모델 지원과 무료 한도, 각 수집 제공자의 접근·보관 조건을 확인한다. 확인하지 못한 출처는 `needs_setup` 또는 `blocked`로 둔다.
4. `/admin/bot`의 커뮤니티 운영 탭에서 계정 준비를 실행한다. 준비 결과에는 비서 일반 계정 UUID와 출처별 설정 성공 여부만 기록하고 자격 증명은 기록하지 않는다.
5. `enabled=true`, `publishing_enabled=false`로 수집만 켠 뒤 관리자 시험 실행을 한 번 수행한다. 디시·네이버·YouTube 각각에 대해 성공 자료 또는 구체적인 제한 이유, 근거 링크, 생성 초안, 모델 호출 수를 확인한다. 시험 실행도 무료 호출량을 소비한다. 현재 로컬 증거에서는 디시만 실제 접근했고, 네이버·YouTube 키는 없었으며 운영 환경은 확인하지 않았다.
6. 운영 범위를 검토한 관리자가 자동 게시를 켠다. 같은 한국 날짜의 `ready` 시험 초안은 정책→실행 순서로 잠근 상태에서 근거가 남아 있고 렌더링 hash가 일치할 때만 게시 가능한 상태로 승격된다. 실제 게시 RPC도 같은 lock 안에서 승인된 제목과 HTML의 UTF-8 SHA-256을 다시 계산한 뒤 게시판 writer를 호출한다. 설정 요청 자체는 게시글을 만들지 않는다. 직접 dry-run 게시, 이전 날짜 초안, 일시 중지 상태, 사라진 근거, hash 불일치는 계속 거부된다.
7. 기존 Codex 초안 자동화가 활성 상태인지 조회한다. 중복이면 사용자 의도에 맞게 초안 작성과 운영 점검 역할을 분리하고, 서버 worker 하나만 게시를 담당하도록 정리한다.
8. 첫 게시 후 실제 공개 상태, `BGMS AI 비서` 작성자 표시, 모바일 본문, 근거 링크를 확인한다. 같은 날 두 번째 worker 실행과 응답 유실 재시도가 게시글 수를 늘리지 않는지 확인한다.
9. 장애 시 관리자 화면의 `일시 중지`를 사용해 `enabled=false`, `publishing_enabled=false`를 한 요청으로 저장하고 workflow 변수 `COMMUNITY_AGENT_SCHEDULE_ENABLED=false`로 정지한다. 이후 `수집 재개`는 `enabled=true`만 저장하므로 자동 게시는 별도로 다시 켜야 한다. 이미 발행된 글은 보존한다. 잘못된 글의 수정·숨김은 구체적인 게시글을 확인한 운영자가 처리한다. 스키마 삭제를 첫 rollback 단계로 사용하지 않는다.

## 근거와 영구 인용

현재 저장 구조에는 사이트 내부 `배그 소식` 글이 PUBG 원 제작자가 제공한 본문이라는 관계가 없다. 내부 글에 PUBG 공식 URL이 있고 관리자 작성 글이어도 공식 본문 근거로 재사용하지 않는다. 이 때문에 공식 수치나 변경 사항을 다룰 후보가 줄어들 수 있으며, 신뢰할 수 있는 원 제작자 연동이 생길 때까지 자료가 부족하면 발행을 보류한다. 검증된 PUBG 공식 YouTube 채널의 영상 설명은 공식 사실 후보로 계속 사용할 수 있지만 semantic 검증을 별도로 통과해야 한다.

게시글의 각 인용에는 서버가 정한 출처 유형, 열람 범위, evidence의 수집 확인 시각을 남긴다. 외부 제목은 인용 라벨로 사용하지 않으며, 특히 YouTube는 `YouTube 공식 영상` 또는 `YouTube 공개 댓글`이라는 정적 라벨을 유지한다.

## 제공자 설정 오류

자격 증명 값은 로그나 상태 응답에 남기지 않는다. 설정된 네이버 연동의 HTTP 401은 `needs_setup`으로, YouTube의 명시적인 `keyInvalid` 사유는 `needs_setup`으로 표시한다. YouTube quota 초과, 일반 `forbidden`, `commentsDisabled`는 자격 증명 오류로 바꾸지 않고 각각의 제한 또는 부분 성공 상태를 유지한다.

## YouTube 활성화 조건

YouTube는 기본적으로 선택 해제되어 있다. 활성화 전에 [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)와 [Derived Metrics Policy](https://developers.google.com/youtube/terms/derived-metrics-policy)의 현재 조건을 확인하고, 실제 클라이언트가 필요한 추가 정책을 수락했으며 댓글 NLP·시청자 반응 분석이라는 사용 목적이 허용 범위에 맞는지 운영자가 기록한다. 이는 모든 요약을 금지한다는 판단이 아니며, 일반적인 API key 발급만으로 허용 조건이 충족됐다는 판단도 아니다.

YouTube 영상 제목·설명·댓글 같은 원시 API metadata는 참조된 실행이 있어도 수집 후 30일 안에 삭제한다. 게시글은 삭제하지 않으며 영구 인용 링크에는 API 영상 제목 대신 정적 출처·열람 라벨과 evidence 확인 시각을 표시한다. 통계·파생 분석을 더 오래 보관하려면 원문과 분리하고 해당 정책에서 허용하는 범위를 별도로 검증한다. 다른 출처의 발췌문은 7일, 미게시 초안은 30일, 실행 metadata는 90일이라는 기존 수명주기를 유지한다.

YouTube 채널 ID와 uploads playlist cache는 성공할 때마다 갱신한다. `last_success_at` 이후 30일 동안 성공이 없으면 정리한다. 출처가 중지되거나 설정되지 않아도 `updated_at`만 갱신됐다는 이유로 오래된 channel cache를 보존하지 않는다.

## 정지 중 cleanup

자동 게시 변수가 꺼져 있어도 GitHub Actions와 서버가 동작하면 매일 cleanup-only 경로가 발췌문, 초안, 실행 metadata, YouTube 원시 metadata를 정리한다. GitHub Actions 자체가 꺼졌거나 서버가 응답하지 않으면 cleanup도 실행되지 않으므로 관리자가 인증된 cleanup-only 작업을 수동으로 실행하고 결과를 확인한다. cleanup-only 경로는 수집, 모델 호출, 게시를 수행하지 않는다.

## 운영 비용과 한도

한 실행의 Gemini 호출은 분류·작성·검증 합계 최대 3회이며 실패 호출도 소비량에 포함된다. 모델 fallback이나 자동 유료 전환은 없다. 현재 개발 smoke 5회에서 기록된 사용량은 prompt 12,713, completion 1,634, 합계 14,347 tokens였다. 별도의 최소 연결 확인 1회는 사용량을 기록하지 않았고, 이 수치를 제공자 청구량으로 보지 않는다. 무료 tier를 전제로 검증했지만 유료 전환이나 결제 작업은 수행하지 않았으며 실제 청구 내역은 조회하지 않았다. 실제 활성화 전 현재 가격과 quota를 다시 확인한다.

## 2026-09-09 네이버 API HUB 연결 확인

새로 발급한 API HUB 인증정보는 develop 로컬 서버의 Git 제외 `.env.local`에 저장했다. 네이버 수집기를 공식 API HUB endpoint와 NCP 인증 헤더로 전환했고, Next 개발 서버의 환경 재로딩을 확인했다. 운영 배포 환경에는 키를 추가하지 않았다.

인증 probe 1회(HTTP 200, 결과 5건)와 실제 `collectSource("naver")`의 검색 3회가 모두 HTTP 200으로 성공했다. 실제 수집기 결과는 검색 60건에서 지정 카페 근거 6건이며 모두 검색 요약(snippet)이다. 전체 본문을 읽었다고 취급하지 않는다. 원문/검색 결과는 DB나 로그에 보존하지 않았고, 기존 `community_agent_sources`의 네이버 연결 상태와 확인 시각만 비교 후 갱신했다. 실행 기록·모델 호출 수·자동 게시 정책은 변경하지 않았다. 오늘의 이전 보류 실행은 그대로 남는다.

검증: source/flow 18 tests, community 89 tests, scoped ESLint, TypeScript, diff check 통과. 인증정보를 URL이나 커밋에 포함하지 않는 회귀 검증을 추가했다. [공식 카페글 검색 명세](https://api.ncloud-docs.com/docs/naver-api-hub-search-cafearticle)를 기준으로 연결했다.
