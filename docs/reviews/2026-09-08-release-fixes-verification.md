# 배포 전 지적 수정 및 재검증

## 마지막 배포 리뷰 추가 확인

같은 날 사용자 요청으로 `git fetch origin` 후 다시 비교했다. 배포 기준 main은 여전히 `0c03b0833c7b364ba1314932e9263c6203719f5f`이며 제품 코드 수정 없이 검토했다. 추적 파일 차이 외에 미추적 신규 모듈·테스트·SQL도 포함했다. 이번 주요 회귀 검사 8파일 **339개 통과**, `git diff --check` 통과. 운영 DB의 기절·생존 nullable integer 컬럼도 다시 확인했다.

main의 [PR Verify](https://github.com/ka6865/BGMS/actions/runs/34164216327)와 Vercel 커밋 상태는 success다. 직전 전체 테스트·빌드·세 사용자 응답 검증 이후 제품 코드 변경이 없으므로 빌드를 반복하지 않았다. 검토한 코드·테스트·SQL 40파일의 SHA-256 목록을 `/tmp/bgms-final-release-review-manifest.json`에 기록했다.

릴리스에는 미추적 `lib/pubg-analysis/aiSummaryJudgment.ts`, 새 회귀 테스트, `supabase/migrations/20260908103306_player_match_basic_combat_stats.sql`을 반드시 포함해야 한다. `git diff`에 보이는 기존 파일만 커밋하면 신규 import 모듈이 빠질 수 있다. 사용자 소유 `pnpm-lock.yaml`, `pnpm-workspace.yaml`은 이번 기능 릴리스 범위에서 제외한다. 새 변경 자체의 PR CI/CD는 아직 실행하지 않았다.

마지막 독립 리뷰 두 건도 완료했다. 기본 전적의 전체 저장·조회·fallback·표시 경로와 AI의 카드 계약·표본 범위·생성/캐시 정규화·개별/스쿼드 정책에서 추가 배포 차단 결함은 확인되지 않았다. **최종 판단: 신규 파일을 포함한 PR의 CI·Vercel 검증을 통과하면 main 배포 진행 가능.** 기존 Gemini 형식 실패는 아래 별도 후속 항목으로 유지한다.

---

2026-09-08 develop 작업 트리. [직전 최종 리뷰](2026-09-08-final-predeploy-review.md)의 P1 한 건과 P2 두 유형을 수정했다. 이번 수정 범위에서 추가 배포 차단 결함은 확인하지 못했다. 커밋·푸시·PR·배포는 아직 수행하지 않았다.

## 수정 결과

| 대상 | 수정 | 확인 |
| --- | --- | --- |
| 개별 전적 목록의 raw fallback | 실제 없는 `match_stats_raw.survival_time` SELECT 제거 | 존재하지 않는 컬럼 요청 시 오류를 내는 DB 모킹으로 수정 전 실패·수정 후 성공. 운영 DB에서 동일 컬럼 SELECT 실행 성공 및 세 사용자 기록 확인. |
| 개별 전적 수집·분석 저장·R2 복원 | 미관측 기절·생존 필드를 conflict update에서 생략. 동일 필드 조합끼리 묶어 저장 | 실제 Supabase SDK가 보내는 URL·columns·JSON을 검사. 혼합 복원 묶음에서도 기존 양수 보존, 관측 0 저장, 신규 미관측 NULL 유지 확인. 개별 분석의 단일행 저장도 같은 필드 정리 적용. |
| 최근 최대 10경기 AI | ‘높여야 하는 것은 아닙니다’, ‘높여야 할 필요는 없습니다’, ‘높여서는 안 됩니다’ 등 확인된 부정·금지 어미 보존 | 실제 권고는 계속 제한. 카드 정규화와 캐시 파싱에서 정상 의견·승자 유지 확인. |
| 개별 경기 AI | ‘소생 시간을 줄여야 한다는 뜻은 아닙니다’, ‘단축해야 한다는 뜻은 아닙니다’ 등 확인된 부정문 보존 | 문장 단위로 검사해 인접한 정상 설명을 유지하고 잘못된 소생 시간 단축 권고만 교체. 첫 처리·캐시 재처리 결과 일치. |

저장 처리는 먼저 DB를 읽어 기존 값을 합치지 않는다. 일반적인 완전한 수집 묶음은 기존처럼 한 번 저장한다. 두 nullable 필드의 관측 여부가 섞인 복원 묶음은 최대 네 필드 조합으로 나뉠 수 있다. Supabase SDK의 bulk column 합집합 때문에 누락 키가 NULL 갱신으로 포함되는 것을 막기 위해 필요한 분리다. [PostgREST upsert 문서](https://docs.postgrest.org/en/stable/references/api/tables_views.html#upsert)와 설치된 SDK의 columns 생성 코드를 확인했다. 운영 DB에 테스트 upsert를 수행한 것은 아니며, conflict 결과 보존 검증은 네트워크 요청을 가로챈 테스트에서 수행했다.

이번 작업에는 새 DB 마이그레이션, 운영 데이터 일괄 갱신, R2 복원 실행, 캐시 일괄 삭제가 없다. 앞서 적용한 nullable 컬럼 마이그레이션은 계속 필요하다. 저장 키·지표 수식·텔레메트리 계산 버전은 변경하지 않았다.

## 최종 검증

- 수정 전 회귀 검사: 5파일의 12개 실패로 조회·NULL 덮어쓰기·부정문 오류 재현. 독립 재리뷰가 추가로 찾은 부정/금지 변형 5개도 먼저 실패를 확인한 뒤 보강했다.
- 최종 전체 Vitest: **211파일 통과 / 5파일 건너뜀, 2,581개 통과 / 76개 건너뜀**. 종료 코드 0. 로그: `/tmp/bgms-release-fixes-all-final.log`.
- 최종 `npm run verify:core`: 종료 코드 0. TypeScript 성공, ESLint 오류 0건·기존 경고 41건. 로그: `/tmp/bgms-release-fixes-core-verified.log`.
- 최종 `npm run build`: 종료 코드 0. 프로덕션 컴파일, TypeScript 및 페이지 생성 성공. 로그: `/tmp/bgms-release-fixes-build.log`.
- 최종 `git diff --check`: 성공.
- 두 독립 재리뷰에서 이번 수정에 추가 확정 결함 없음. AI의 임의 자연어 전체를 검증한다는 의미는 아니다.

타입 검사 중 새 저장 helper가 기존 모드·맵 입력의 unknown 타입을 드러내 두 필드에 문자열 검사를 추가했다. 이후 관련 테스트와 전체 테스트·빌드를 다시 통과했다.

## 세 사용자 응답

| Steam 사용자 | 로컬 목록 API | 기절·생존 둘 다 확인된 경기 | 개별 경기 AI | 최근 최대 10경기 AI | 스쿼드 AI |
| --- | --- | --- | --- | --- | --- |
| KangHeeSung_ | HTTP 200, 20건 | 18건 | 착한맛·매운맛 통과 | 통과 | 착한맛·매운맛 통과 |
| MiaeQ_Q | HTTP 200, 20건 | 11건 | 착한맛·매운맛 통과 | 통과 | 착한맛·매운맛 통과 |
| What12_9oing_on | HTTP 200, 20건 | 20건 | 착한맛·매운맛 통과 | 통과 | 착한맛·매운맛 통과 |

목록은 로컬 API에서 운영 DB를 읽은 실제 응답이다. 누락 기록은 0으로 채우지 않았다. 켜져 있던 개발 서버는 요청이 timeout되어 해당 develop 프로세스를 정상 종료 후 재시작했다. 이후 목록·요약 요청에 200 응답을 확인했으며 `http://localhost:3000`에서 실행 중이다. 서버 무응답의 근본 원인을 이번 검사만으로 확정하지 않았다. 이번에는 새 브라우저 화면·모바일 레이아웃 QA를 시행하지 않았다.

AI는 **앞선 실제 Gemini 응답 15개를 현재 제품 라우트로 재생한 검증**이다. 현재 요청의 프롬프트·시스템 지시와 캡처 자료가 일치하는지 확인하고, 정규화된 최종 응답 및 캐시 재조회를 검사했다. 결과는 15/15 통과이며 새 Gemini 호출은 0회다. 인증·캐시 쓰기는 메모리로 대체했다. 원본 텔레메트리 재계산이나 배포 환경 인증·네트워크 E2E를 새로 수행한 것은 아니다.

AI 재검증 로그: `/tmp/bgms-release-fixes-three-user-final.log`. 최종 응답: `tmp/three-user-validation/release-fixes/report.json`. 이전 사용자별 선별 경기 범위는 [세 사용자 검증 보고서](2026-09-08-three-user-ai-validation.md)와 같다. 스쿼드 미측정 지표·종합 등급 보류도 유지한다.

## 배포 판단

앞서 확인한 세 가지 차이 결함은 해결되어 **PR 및 CI/CD 확인 단계로 진행 가능한 상태**다. 새 변경이 아직 미커밋이므로 새 PR CI/CD를 통과했다고 볼 수는 없다.

기존 Gemini의 간헐적 응답 형식 실패(`AI summary provider is temporarily unavailable`)는 별도 미해결 항목이다. 이번 수정은 그 오류의 분류·자동 재시도를 구현하지 않았다. 따라서 ‘AI 분석의 모든 실패가 해결됨’ 또는 ‘운영 환경까지 배포 검증 완료’로 보고하지 않는다.
