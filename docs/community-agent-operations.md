# BGMS 커뮤니티 비서 운영 절차

현재는 글·답글 모두 운영자의 항목별 승인이 필요하다. `publishing_enabled=true`는 허용하지 않는다. 아래 날짜별 검증 기록의 과거 설정값과 현재 운영 정책을 구분한다.

2026-09-09 관리자 상태 조회 오류를 복구하면서 연결된 Supabase에 `community_agent_persistence` migration을 적용했다. 원격 migration version은 `20260909061622`, 적용 SQL 원본은 `20260909061622_community_agent_persistence.sql`이다. 정책·출처·최근 실행 조회가 정상이며 수집과 자동 게시는 모두 꺼져 있다. 운영 앱 배포, GitHub Actions 활성화, 비서 계정 생성, 실제 자료 수집·게시는 아직 실행하지 않았다. 서버만 게시를 담당하며 외부 디시인사이드·네이버 카페·YouTube에는 글이나 댓글을 작성하지 않는다.

## 설정 위치

| 위치 | 설정 |
| --- | --- |
| 서버 | 기존 Supabase/Gemini 환경, `COMMUNITY_AGENT_WORKER_SECRET`, 선택적 `COMMUNITY_AGENT_MODEL`, `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`, `YOUTUBE_DATA_API_KEY` |
| GitHub Actions | secret `COMMUNITY_AGENT_WORKER_SECRET`; vars `APP_URL`, `COMMUNITY_AGENT_SCHEDULE_ENABLED`(기본 `false`) |
| DB 초기값 | `enabled=false`, `publishing_enabled=false`, YouTube 출처 선택 해제. 수집 활성화 후에도 항목별 승인 필요 |

네이버 카페 검색은 Naver API HUB의 `https://naverapihub.apigw.ntruss.com/search/v1/cafearticle?format=json` 엔드포인트를 사용한다. 서버 환경 변수 이름은 기존 `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`를 유지하되 요청 헤더에는 각각 `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY`를 사용한다. 키 값은 URL이나 로그에 기록하지 않는다.

제공자 키가 존재한다는 사실만으로 활성화 준비가 끝난 것은 아니다. 배포 런타임, 무료 한도, 접근 조건, 보관 조건을 각각 확인한 뒤 출처를 켠다.

## 최초 적용과 활성화

1. `npm run verify:community`, `bash scripts/verify_community_agent_migration.sh`, `npm run verify:admin`, `npm run verify:core`, `git diff --check` 결과를 저장한다. migration은 커뮤니티 비서 전용 네 테이블과 service-role 전용 RPC를 추가한다. 기존 이용자 게시글·댓글을 삭제하지 않는다.
2. 운영 적용 전 migration 상태와 `write_board_post_with_images`의 존재 및 현재 서명을 확인한다. 운영 DB 변경과 배포에 대한 기존 승인이 없다면 적용 SQL, 영향, 검증 결과를 제시하고 최종 승인을 받는다.
3. 배포 환경의 함수 실행시간, Gemini 모델 지원과 무료 한도, 각 수집 제공자의 접근·보관 조건을 확인한다. 확인하지 못한 출처는 `needs_setup` 또는 `blocked`로 둔다.
4. `/admin/bot`의 커뮤니티 운영 탭에서 계정 준비를 실행한다. 준비 결과에는 비서 일반 계정 UUID와 출처별 설정 성공 여부만 기록하고 자격 증명은 기록하지 않는다.
5. `enabled=true`, `publishing_enabled=false`로 수집만 켠 뒤 관리자 시험 실행을 한 번 수행한다. 디시·네이버·YouTube 각각에 대해 성공 자료 또는 구체적인 제한 이유, 근거 링크, 생성 초안, 모델 호출 수를 확인한다. 시험 실행도 무료 호출량을 소비한다. 현재 로컬 증거에서는 디시만 실제 접근했고, 네이버·YouTube 키는 없었으며 운영 환경은 확인하지 않았다.
6. 검증된 초안을 관리자 검토 큐에 저장하고 글·답글마다 승인 또는 거절한다. 승인 RPC는 정책, 대상 원문, 만료, 계정과 한도를 다시 검사한다. 수집 설정이나 worker 실행만으로 공개 게시하지 않는다.
7. 기존 Codex 초안 자동화가 활성 상태인지 조회한다. 중복이면 초안 작성·운영 점검 역할을 정리하고 예약 worker는 수집과 검토 알림만 담당하도록 한다.
8. 첫 승인 후 실제 공개 상태, `BGMS AI` 작성자 표시, 모바일 본문, 근거 링크를 확인한다. 동일 승인을 반복해도 게시글·답글 수가 늘어나지 않는지 확인한다.
9. 장애 시 `일시 중지`로 `enabled=false`를 저장하고 workflow 변수 `COMMUNITY_AGENT_SCHEDULE_ENABLED=false`로 정지한다. 이후 `수집 재개`는 초안 수집만 재개하며 실제 게시는 계속 항목별 승인을 요구한다. 이미 발행된 글과 검토 기록은 보존한다. 잘못된 글은 운영자가 구체적인 내용을 확인한 뒤 수정·숨김 처리한다.


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


## 2026-09-09 관리자 재실행과 수집 설정 개선

커뮤니티 탭의 내부 스크롤을 복구하고, 세 출처 선택과 API 키 등록 여부를 화면 상단에 배치했다. 현재 키 존재 여부와 과거 수집 실패는 별도로 표시한다. `COMMUNITY_AGENT_WORKER_SECRET`은 예약 실행기 전용 내부 암호이며, 관리자 수동 시험 실행·재실행에는 필요하지 않다. 자동 예약을 연결할 때 서버와 실행기 양쪽에 동일한 값을 등록한다.

당일 `deferred` 또는 `failed` 실행은 ‘다시 수집·초안 만들기’로 재실행한다. `POST /api/admin/agent/community/run`의 `{action: "retry", runId: 이전실행ID}`는 관리자만 사용할 수 있으며, 수집이 켜져 있고 자동 게시가 꺼진 상태에서만 새 dry-run을 생성한다. 기존 실행과 모델 사용량을 보존하고, 새 실행은 현재 출처 설정으로 시작한다. 실행당 Gemini 호출 상한 3회는 유지하며 수동 재실행마다 별도 사용량이 발생한다. 진행 중·검증 완료·발행 완료·지난 날짜 실행은 이 경로로 새로 시작하지 않는다. 진행 중 lease 만료를 자동 회수하는 UI 개선은 이번 범위에 포함하지 않았다.

마이그레이션 `community_agent_manual_retry`를 현재 연결된 DB에 적용했다. 로컬 원본 `20260909100149_community_agent_manual_retry.sql`, 원격 버전 `20260909100149`. `community_agent_runs.retry_of`와 재시도 선행 실행별 고유 인덱스를 추가하고, 기존 날짜 고유 제약을 활성/검증 완료/발행 실행에 적용되는 날짜 고유 인덱스로 교체했다. 기존 1개 실행 기록은 그대로이며 데이터 삭제와 실제 재수집·게시는 하지 않았다. 적용 직후 실행 테이블+인덱스 합계는 81,920바이트로 적용 전과 같다. 행당 재시도 연결 UUID 및 소규모 인덱스 추가 외 대용량 데이터 증가는 없다.

동시 재시도는 정책 행 lock과 고유 인덱스로 같은 후속 실행을 반환한다. 보류 기록이 여러 개여도 자동 게시 승격은 검증 완료된 실행만 선택하며, 하루 1건 발행 제한을 유지한다. 일반 worker의 start는 최신 실행을 반환하고 자동 재시도를 만들지 않는다. 기존 RLS와 서버 전용 권한을 유지했다. 되돌릴 때는 UI/API의 retry 노출을 먼저 되돌리고 기록 보존을 위해 DB의 재시도 열과 인덱스는 유지한다. 여러 실행이 생긴 후 기존 날짜 고유 제약을 바로 복원하지 않는다.

검증: 커뮤니티 101 tests, 수정 파일 ESLint, TypeScript, PostgreSQL 17의 이력 보존/권한/재시도 멱등성/초안 승격/실제 게시 writer/동시 재시도/동시 발행/중지 경합 검사 통과. 모의 로그인·API와 실제 페이지/레이아웃/CSS로 375×667, 390×844, 430×932, 1280×720에서 스크롤, 출처 토글, 관리자 재실행 → 6단계 완료(게시 호출 없음)를 확인했다.

## 2026-09-09: 게시글·답글 사람 승인으로 전환 (현재 동작)

초기 자동 게시 구현은 폐기했다. 현재는 `publishing_enabled=true`를 DB에서 거부하며 `publish_community_post`도 `approval_required`를 반환한다. 기존 예약 worker는 검증 완료 후 멈춘다. 모든 게시글은 `BGMS AI` 계정으로 `posts.status=draft`와 `community_content_reviews.status=pending`에 저장되고, 답글은 비공개 검토 큐에만 저장된다. 사용자의 항목별 승인만 실제 게시/댓글 작성을 허용한다.

- 로컬 migration: `20260909111045_community_content_reviews.sql`, 알림 결과 보완 `20260909111823_community_review_notification_outcomes.sql`.
- 검토 API: `/api/admin/agent/community/reviews`. GET은 관리자만 전체 초안/대상 댓글 확인. POST `approve`/`reject`는 관리자 세션에서만 처리. worker는 `process`만 허용하며 승인할 수 없다.
- 승인 시 정책→검토→게시글/댓글 순서로 잠그고 원본 snapshot, bot 계정, 공개 상태, 만료, 카테고리, 하루 게시 한도를 재검사한다. 동일 승인/거절을 반복해도 공개 글/댓글은 한 번만 작성된다. 거절은 감사 기록과 비공개 초안을 보존한다.
- 답글 대상: 최근 7일 내 봇 소유 공개 글에 달린 비봇 댓글. 댓글별 한 번, 한국 날짜 기준 생성 시도 하루 최대 5개, 호출당 Gemini 최대 1회. 근거는 해당 글/부모 댓글/대상 댓글과 조회한 공식 원문이며 모델 명령과 분리한다. 근거 부족·잘못된 응답은 미게시 실패 기록으로 남긴다. 이미 처리한 댓글의 재생성 기능은 없다.
- 검토 기한 7일. 일시 중지는 승인 발행도 막는다. 글 발행 하루 최대 1건. 승인 시 실제 본문과 대상 댓글이 달라졌으면 `target_changed`; 내용을 다시 확인해야 한다.

### Discord 설정

기존 운영 알림 `DISCORD_WEBHOOK_URL`을 사용한다. 공개 커뮤니티 알림용 `DISCORD_COMMUNITY_WEBHOOK_URL`은 승인 초안 전송에 사용하지 않는다. 별도 검토 채널을 원하면 `DISCORD_COMMUNITY_REVIEW_WEBHOOK_URL`을 지정한다. 웹훅만 있으면 전체 초안/대상 댓글과 로그인 필요한 관리자 검토 링크를 보낸다. 링크 열기(GET)는 승인이나 게시를 실행하지 않는다.

Discord 안에서 직접 승인·거절하려면 서버에 다음을 등록한다.

- `DISCORD_BOT_TOKEN`: 기존 Discord 앱의 봇 토큰. 검토 채널에서 메시지 전송/첨부 권한 필요.
- `DISCORD_COMMUNITY_APPROVER_ID`: 승인할 소유자의 Discord 사용자 ID.
- `DISCORD_COMMUNITY_REVIEW_PUBLIC_KEY`, `DISCORD_COMMUNITY_REVIEW_APPLICATION_ID`: 검토 봇의 public key와 application ID. 기존 `DISCORD_PUBLIC_KEY`의 다른 슬래시 명령 앱과 분리해 서명을 검증한다.
- 선택 `DISCORD_COMMUNITY_REVIEW_CHANNEL_ID`: 생략하면 운영 웹훅 metadata의 채널 ID를 조회한다.
- 앱 Interactions Endpoint URL: `https://bgms.kr/api/discord/interactions`.

공식 프로토콜: [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding). 서명/최근 timestamp/사용자 검증 후 즉시 defer하고, DB/채널 확인과 실제 결정은 Next after에서 수행한다. 저장된 메시지 ID와 현재 채널을 검증하며 비소유자에게 권한이 없다. 처리 결과는 기존 Discord 메시지와 ephemeral 응답에 반영한다. 멘션 알림은 비활성화한다. 긴 초안은 전체 텍스트 첨부파일과 검토 페이지에서 확인한다.

알림은 DB claim으로 한 건씩 전송한다. 실패하면 초안은 유지하고 5분 뒤 재시도 가능하다. 승인 결과 메시지 수정 실패도 다음 처리에서 재시도한다. Discord HTTP 응답 유실은 중복 알림을 만들 수 있지만 동일 검토 ID의 중복 공개는 DB에서 차단한다.

### 예약 실행과 배포

`.github/workflows/community-agent.yml`: 매일 한국 오전 9시 게시글 수집/초안 생성.
`.github/workflows/community-reviews.yml`: 15분마다 답글 초안 최대 1개/알림 1개 처리.
두 실행기 모두 `COMMUNITY_AGENT_SCHEDULE_ENABLED=true`, 운영 `APP_URL`, 양쪽이 같은 `COMMUNITY_AGENT_WORKER_SECRET` 설정이 필요하다. 코드만 추가했다고 실행기가 활성화된 것은 아니다. 배포 후 관리자 검토 링크/로그인 이동과 실제 Discord 버튼을 검증한 다음 예약을 활성화한다.

현재 작업에서는 기존 검증 완료 실행을 168번 비공개 draft와 검토 ID `58bcea61-128f-4caf-b9d5-74dca867cbc5`로 연결했다. 공개 발행/실제 답글 작성은 하지 않았다. 운영 사이트 배포, 개발 서버에는 원본 작업 폴더의 봇 설정을 아직 복사하지 않았다. 기존 BGMS 앱(1490545661702307840)과 소유자 kangheesung_를 API로 확인했으나, 운영 알림 채널 접근은 403이고 Interactions Endpoint는 미등록이다. 봇 초대/채널 권한, 검토 앱 전용 public key와 endpoint 연결, 예약 활성화 및 실제 알림 발송은 운영 연결이 남아 있다.

## 2026-09-10: 답글의 공식 패치노트 근거 조회

`reply-evidence.ts`는 게시글의 공식 PUBG 패치노트 링크를 먼저 읽는다. 링크가 없으면 제목의 정확한 패치 버전으로 공식 목록에서 원문을 찾는다. 실제 목록의 Nuxt 데이터는 id/title 리터럴만 읽고 스크립트를 실행하지 않는다. 원문의 자체 제목에서 버전을 재검사하므로 최신 글이나 관련 글의 버전을 잘못 인용하지 않는다. 조회 범위는 공식 한국어 패치노트이며 일반 웹 검색·댓글 URL 탐색은 하지 않는다.

외부 조회는 전체 10초, 최대 3회(리다이렉트 포함), 응답당 2MiB로 제한한다. 모델에는 최대 12,000자의 본문과 확인 시각, 한국 시간대, 일정 구간을 전달한다. 일정 질문에 원문이 없거나 공식 채널로 돌려보내기만 하는 답글은 보류한다. 정상 초안에는 서버가 출처 링크를 붙이고 usage에 출처/확인 시각/원문 발췌를 남긴다. 승인 전에는 공개 답글을 만들지 않는다.

43.1 제목과 “업데이트가 언제야?” 질문으로 공식 목록→원문→Gemini 실제 호출을 검증했다. PC 9월 10일 09:00~17:30, 콘솔 9월 17일 10:00~18:00 예정이라는 구체적인 답변과 원문 링크가 생성됐다. 기존 168번 게시글과 67번 댓글은 삭제되어 DB를 변경하지 않는 로컬 QA로 검증했으며, 기존 검토 항목을 재발행하거나 덮어쓰지 않았다. 운영 배포/Discord 연결 상태는 위의 미완료 항목과 같다.

## 답글 생성 실패 대응

답글 초안은 댓글당 한 번 생성하며 실패·기한 만료 건을 자동 재생성하지 않는다. `새 초안 처리`는 아직 처리하지 않은 댓글을 대상으로 한다. 모델의 일시 오류나 근거 부족으로 실패한 댓글은 검토 목록에서 원문 게시글을 열어 운영자가 직접 답글을 작성한다. 실패 기록을 지우거나 재생성하기 위한 관리자 API는 이번 범위에 포함하지 않는다. 중복 응답과 반복 모델 호출을 피하기 위한 현재 제한이며, 실패 안내에도 직접 대응 경로를 명시한다.
