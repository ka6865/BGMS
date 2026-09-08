# BGMS 커뮤니티 비서 운영 절차

이 기능은 현재 코드와 로컬 검증만 완료된 상태다. 운영 Supabase migration, 배포, GitHub Actions 활성화, 실제 제공자 수집, 자동 게시를 수행했다는 뜻이 아니다. 서버만 게시를 담당하며 외부 디시인사이드·네이버 카페·YouTube에는 글이나 댓글을 작성하지 않는다.

## 설정 위치

| 위치 | 설정 |
| --- | --- |
| 서버 | 기존 Supabase/Gemini 환경, `COMMUNITY_AGENT_WORKER_SECRET`, 선택적 `COMMUNITY_AGENT_MODEL`, `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`, `YOUTUBE_DATA_API_KEY` |
| GitHub Actions | secret `COMMUNITY_AGENT_WORKER_SECRET`; vars `APP_URL`, `COMMUNITY_AGENT_SCHEDULE_ENABLED`(기본 `false`) |
| DB 정책 | `enabled=false`, `publishing_enabled=false`, YouTube 출처 선택 해제로 배포 |

제공자 키가 존재한다는 사실만으로 활성화 준비가 끝난 것은 아니다. 배포 런타임, 무료 한도, 접근 조건, 보관 조건을 각각 확인한 뒤 출처를 켠다.

## 최초 적용과 활성화

1. `npm run verify:community`, `bash scripts/verify_community_agent_migration.sh`, `npm run verify:admin`, `npm run verify:core`, `git diff --check` 결과를 저장한다. migration은 커뮤니티 비서 전용 네 테이블과 service-role 전용 RPC를 추가한다. 기존 이용자 게시글·댓글을 삭제하지 않는다.
2. 운영 적용 전 migration 상태와 `write_board_post_with_images`의 존재 및 현재 서명을 확인한다. 운영 DB 변경과 배포에 대한 기존 승인이 없다면 적용 SQL, 영향, 검증 결과를 제시하고 최종 승인을 받는다.
3. 배포 환경의 함수 실행시간, Gemini 모델 지원과 무료 한도, 각 수집 제공자의 접근·보관 조건을 확인한다. 확인하지 못한 출처는 `needs_setup` 또는 `blocked`로 둔다.
4. `/admin/bot`의 커뮤니티 운영 탭에서 계정 준비를 실행한다. 준비 결과에는 비서 일반 계정 UUID와 출처별 설정 성공 여부만 기록하고 자격 증명은 기록하지 않는다.
5. `enabled=true`, `publishing_enabled=false`로 수집만 켠 뒤 관리자 시험 실행을 한 번 수행한다. 디시·네이버·YouTube 각각에 대해 성공 자료 또는 구체적인 제한 이유, 근거 링크, 생성 초안, 모델 호출 수를 확인한다. 시험 실행도 무료 호출량을 소비한다. 현재 로컬 증거에서는 디시만 실제 접근했고, 네이버·YouTube 키는 없었으며 운영 환경은 확인하지 않았다.
6. 운영 범위를 검토한 관리자가 자동 게시를 켠다. 같은 한국 날짜의 `ready` 시험 초안은 정책→실행 순서로 잠근 상태에서 근거가 남아 있고 렌더링 hash가 일치할 때만 게시 가능한 상태로 승격된다. 설정 요청 자체는 게시글을 만들지 않는다. 직접 dry-run 게시, 이전 날짜 초안, 일시 중지 상태, 사라진 근거, hash 불일치는 계속 거부된다.
7. 기존 Codex 초안 자동화가 활성 상태인지 조회한다. 중복이면 사용자 의도에 맞게 초안 작성과 운영 점검 역할을 분리하고, 서버 worker 하나만 게시를 담당하도록 정리한다.
8. 첫 게시 후 실제 공개 상태, `BGMS AI 비서` 작성자 표시, 모바일 본문, 근거 링크를 확인한다. 같은 날 두 번째 worker 실행과 응답 유실 재시도가 게시글 수를 늘리지 않는지 확인한다.
9. 장애 시 DB 정책의 `enabled=false`와 workflow 변수 `COMMUNITY_AGENT_SCHEDULE_ENABLED=false`로 정지한다. 이미 발행된 글은 보존한다. 잘못된 글의 수정·숨김은 구체적인 게시글을 확인한 운영자가 처리한다. 스키마 삭제를 첫 rollback 단계로 사용하지 않는다.

## YouTube 활성화 조건

YouTube는 기본적으로 선택 해제되어 있다. 활성화 전에 [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)와 [Derived Metrics Policy](https://developers.google.com/youtube/terms/derived-metrics-policy)의 현재 조건을 확인하고, 실제 클라이언트가 필요한 추가 정책을 수락했으며 댓글 NLP·시청자 반응 분석이라는 사용 목적이 허용 범위에 맞는지 운영자가 기록한다. 이는 모든 요약을 금지한다는 판단이 아니며, 일반적인 API key 발급만으로 허용 조건이 충족됐다는 판단도 아니다.

YouTube 영상 제목·설명·댓글 같은 원시 API metadata는 참조된 실행이 있어도 수집 후 30일 안에 삭제한다. 게시글은 삭제하지 않으며 영구 인용 링크에는 API 영상 제목 대신 `YouTube 공식 영상` 또는 `YouTube 공개 댓글`을 표시한다. 통계·파생 분석을 더 오래 보관하려면 원문과 분리하고 해당 정책에서 허용하는 범위를 별도로 검증한다. 다른 출처의 발췌문은 7일, 미게시 초안은 30일, 실행 metadata는 90일이라는 기존 수명주기를 유지한다.

YouTube 채널 ID와 uploads playlist cache는 성공할 때마다 갱신한다. `last_success_at` 이후 30일 동안 성공이 없으면 정리한다. 출처가 중지되거나 설정되지 않아도 `updated_at`만 갱신됐다는 이유로 오래된 channel cache를 보존하지 않는다.

## 정지 중 cleanup

자동 게시 변수가 꺼져 있어도 GitHub Actions와 서버가 동작하면 매일 cleanup-only 경로가 발췌문, 초안, 실행 metadata, YouTube 원시 metadata를 정리한다. GitHub Actions 자체가 꺼졌거나 서버가 응답하지 않으면 cleanup도 실행되지 않으므로 관리자가 인증된 cleanup-only 작업을 수동으로 실행하고 결과를 확인한다. cleanup-only 경로는 수집, 모델 호출, 게시를 수행하지 않는다.

## 운영 비용과 한도

한 실행의 Gemini 호출은 분류·작성·검증 합계 최대 3회이며 실패 호출도 소비량에 포함된다. 모델 fallback이나 자동 유료 전환은 없다. 현재 개발 smoke 5회에서 기록된 사용량은 prompt 12,713, completion 1,634, 합계 14,347 tokens였다. 별도의 최소 연결 확인 1회는 사용량을 기록하지 않았고, 이 수치를 제공자 청구량으로 보지 않는다. 무료 tier를 전제로 검증했지만 유료 전환이나 결제 작업은 수행하지 않았으며 실제 청구 내역은 조회하지 않았다. 실제 활성화 전 현재 가격과 quota를 다시 확인한다.
