# 코드와 문서 찾는 기준

기능을 찾을 때는 화면 → API → 도메인 처리 → 저장 계약 순서로 확인한다. 현재 동작은 구현·package.json·실행 결과를 기준으로 판단한다.

| 경로 | 담당 내용 |
| --- | --- |
| `app/` | 사용자·관리자 페이지와 URL |
| `app/api/` | 요청 입력, 인증·권한, 응답 처리 |
| `components/` | 여러 화면과 기능별 표시 컴포넌트 |
| `components/admin/dashboard/StoragePanel.tsx` | 관리자 데이터 관리 표시. 요청과 확인 상태는 대시보드 페이지가 소유 |
| `lib/admin-agent/` | 관리자 승인·실행·운영 관제와 도구 |
| `lib/admin-agent/storage-limits.ts` | 저장 용량 기준, 플레이어 캐시 보존 기준, 관리자 정리 요청 한도 |
| `lib/pubg/`, `lib/pubg-analysis/` | 전적 조회·수집·분석과 캐시 처리 |
| `utils/supabase/`, `lib/supabase-middleware.ts` | 브라우저·서버 DB 연결과 인증 경계 |
| `types/` | 화면과 서버가 공유하는 데이터 계약 |
| `scripts/` | 정리·백업·수집·검증 CLI. 실행 전 읽기·쓰기·삭제 범위 확인 |
| `supabase/migrations/` | DB 계약 변경 이력. 적용된 파일을 고치지 않고 새 보정 migration 추가 |
| `tests/`, `__tests__/` | 각각 Vitest와 Jest 검사. 한쪽 통과가 다른 쪽 검사를 뜻하지 않음 |
| `tests/fixtures/`, `tests/helpers/` | 운영과 격리한 DB·브라우저 검증 자료와 하네스 |
| `.github/workflows/` | 실제 예약 일정·작업 순서·활성화 조건 |

운영 문서는 아래 경로에서 찾는다.

| 문서 | 사용 목적 |
| --- | --- |
| [운영 문서 색인](operations/README.md) | `docs/operations/` 문서별 현재 계약·작업 기록 구분 |
| [service role 전용 테이블](operations/service-role-only-tables.md) | RLS 정책 없이 서버만 접근하는 테이블과 변경 규칙 |
| [1~8번 최종 배포 검토](operations/2026-10-10-audit-final-release-review.md) | 최신 main 통합 검증과 계산 3 데이터 전환으로 인한 배포 보류 조건 |
| [점검 후속 수정·운영 반영 준비](operations/2026-10-10-audit-followup.md) | 이번 브랜치의 변경점, 실제 DB 조회 결과, 적용 순서와 남은 확인 |
| [점검 4~8번 수정](operations/2026-10-10-audit-fixes-4-8.md) | 지표 집계·이벤트 요청·매치 임팩트·키보드 이동·고객센터 수정과 계산 버전 3 적용 조건 |
| [앞선 승인·캐시·인증 수정](operations/2026-10-10-audit-fixes-1-3.md) | 1~3번 수정과 당시 검증 근거 |
| [매치 추적 운영](operations/pubg-tracking.md) | 수집 worker의 동작과 canary·관찰 방법 |
| [커뮤니티 비서 운영](community-agent-operations.md) | 커뮤니티 검토·승인·운영 흐름 |
| [사용자 점수 설명](tactical_score_guide.md) | 사용자에게 설명하는 점수 기준 |

설계·후속 구현 방향은 아래 문서에서 찾는다. 현재 구현된 기능과 구분해서 읽는다.

| 문서 | 사용 목적 |
| --- | --- |
| [멀티게임·LoL 확장 설계](specs/2026-10-21-multigame-lol-architecture-design.md) | PUBG 기존 URL·구조를 보존하는 멀티게임 목표 설계. 현재 관리자 전용 KR LoL 검색 MVP는 [별도 실행 문서](plans/2026-10-22-lol-private-search-mvp.md)에 기록; DB 영속 저장은 구현됨(`LOL_PERSISTENCE_ENABLED` 선택형), R2·AI·공개 경로는 미구현. 현재 저장·제한·상세 계약은 [영속 저장 기반](plans/2026-10-22-lol-persistence-foundation.md), [운영 적용 준비](plans/2026-10-22-lol-production-persistence.md), [상세 확장](plans/2026-10-22-lol-detail-enrichment.md), [호출 용량 조사](research/2026-10-22-lol-search-capacity.md), [API 제공 정보](research/2026-10-22-lol-api-capabilities.md), [경기 통계 집계](plans/2026-10-23-lol-match-stats.md)를 본다 |
| [LoL 비공개 검색 MVP](plans/2026-10-22-lol-private-search-mvp.md) | 관리자 전용 Riot ID→프로필/랭크/최근 경기, 두 팀 상세·큐 필터·집계, 호출·캐시 제한과 정책·테스트 경계 |
| [LoL 경기 상세 구현·검증](plans/2026-10-22-lol-private-match-details.md) | 경기 상세 DTO/API, Data Dragon 한글 메타, UI 및 현재 로컬 검증 결과 |
| [LoL 관리자 전용 개발 공간 구현 계획](plans/2026-10-21-lol-owner-only-development.md) | 2026-10-22 관리자 권한 전환·검증과 로컬 환경 설정 변경 기록. 2026-10-21 본인 전용 구현·독립 검토는 과거 기록으로 분리. 실제 Next HTTP 검증은 별도 담당, 운영 활성화·배포는 미실행 |

날짜가 붙은 `docs/operations/`·`docs/reviews/` 문서는 해당 시점의 기록이다. 당시 배포 상태를 현재 상태로 단정하지 않는다. 반복해서 쓰는 운영 절차는 관련 구현이 바뀔 때 갱신하고, 적용 여부·확인 일시·검증 범위를 기록한다. 계획 문서는 구현 완료나 배포 완료의 근거로 사용하지 않는다.

`.agents/`, `.agents-drafts/`, `docs-private/`는 Git 제외 대상인 로컬 지침이다. 다른 worktree에 없을 수 있다. 공유 지침은 루트 `AGENTS.md`, 운영 계약은 저장소에 포함된 문서와 구현에 남긴다. 비밀 값·운영 회원 원본·임시 스크린샷을 문서와 커밋에 추가하지 않는다.

- [기존 계산 보존과 신규 계산 적용](operations/2026-10-10-calculation-coexistence-results.md)
