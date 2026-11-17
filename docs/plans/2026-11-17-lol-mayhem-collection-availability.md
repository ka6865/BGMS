# 증바람 수집과 등장 상태 수정 계획

> **For agentic workers:** 실행 시 `superpowers:executing-plans`로 작업별 구현과 검증을 진행한다. 체크박스는 구현·검증 진행 상태이며 운영 적용은 별도 단계다.

**Goal:** 제한 시간에 걸리는 챔피언 통계를 안전하게 이어 수집하고, 실제 미등장 근거가 있는 증강을 현재 사용 가능한 증강과 구분한다.

**Architecture:** 기존 진행 파일과 lease를 이용해 완성된 챔피언 단위로 수집을 나눈다. 등장 상태는 공식 자료를 수정하지 않고 패치별 검토 근거를 공통 함수로 적용한다. 기존 보관함의 `unverified`와 한국어 설명을 사용한다.

**Tech Stack:** 기존 TypeScript, Vitest, Supabase Storage, Next.js, React. 새 의존성과 DB migration은 계획하지 않는다.

**Spec:** [등장 상태 조사와 제안](../research/2026-11-17-lol-mayhem-availability.md). 2026-11-17 사용자가 두 변경의 하위 워크트리 구현과 PR 생성을 승인했다. 12개 기본 목록 제외·확인 중 보존 정책을 적용하며 재장전은 추가 후보로 유지한다.

## 공통 제약

- 운영 자료 삭제, workflow 재실행, 배포, 공식 카탈로그 변경은 이 준비 작업에 포함하지 않는다.
- 공식 삭제·비활성과 통계상 미관측을 구분한다. 적용 대상은 조사에서 근거가 강한 12개, 적용 패치는 `16.22`를 권한다. 재장전 `2126`은 검토 후보로 남긴다.
- 원본 해시·정규화 검증, lease, API 호출 간격, 사용량 보호를 유지한다.
- 클라이언트 원본에서 계산하는 `allowedAugmentIds`, `catalogHash`, 기존 progress 경로에 화면용 제외 규칙을 섞지 않는다.
- 구현 전 설치된 `node_modules/next/dist/docs/`에서 캐시 관련 API 지침을 읽는다. 설명·검증 결과는 한국어로 쓴다.

## 접근안 비교

수집 제한을 9분에서 더 늘리는 것은 수정량이 가장 적지만 외부 응답이 느려지면 재발한다. 기존 checkpoint를 이용해 제한 전에 정상적으로 중단하고 다음 예약 실행에서 이어받는 안을 권한다. 별도 큐나 자동 재실행 workflow는 추가하지 않는다. 이어받기까지 기존 6시간 예약 간격이 발생할 수 있다.

도감에 경고만 붙이는 방식은 검색 결과에 계속 나오며, 기본 도감·추천에서 빼고 기존 보관함에서 확인하게 하는 방식은 현재 사용 가능한 증강과 구별하기 쉽다. 후자를 권장안으로 두되 공식 원본과 과거 이력은 보존한다. 미래 패치에 이 판정을 자동 확장하지 않는다.

## 리뷰 초점

- checkpoint 저장이 끝나기 전에 정상 중단으로 반환하지 않는다.
- 부분 수집은 전체 성공 시각과 공개 포인터를 갱신하지 않는다.
- 진행 파일 손상·버전 혼합·API 오류를 정상 분할 중단으로 감추지 않는다.
- 화면용 제외가 공식 후보의 해시 검증이나 원본 증강 ID 허용 목록을 바꾸지 않는다.
- 현재 도감에서 빠진 증강도 보관함과 관측 이력에서 이유와 과거 기록을 확인할 수 있어야 한다.

## 작업 1 챔피언 통계의 정상 분할 수집

대상: `lib/lol/mayhemChampionIngest.server.ts`, `scripts/lol_mayhem_champion_dataset_sync.ts`, `lib/lol/mayhemAdminUpdates.ts`, `app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel.tsx`.

인터페이스: 기존 `ingestChampionDataset({apply:boolean})`와 progress manifest 형식을 유지한다. 결과 상태에 `deferred_time`을 추가하고 완료 수·전체 수·버전을 기록한다.

- [x] `tests/lol-mayhem-champion-ingest.test.ts`에 가짜 시간과 Storage map을 사용한 실패 테스트를 추가한다. 챔피언 하나의 원본·정규화·progress 저장 후 8분 경계를 넘기면 후보 없이 정상 반환하며, 다음 실행은 완료된 챔피언을 다시 유료 조회하지 않아야 한다.
- [x] 8분을 다음 챔피언 요청 시작 기준으로 두고 기존 9분 hard deadline은 유지한다. 정상 분할은 오류와 구분해 `counts.completed=false`, `counts.status=deferred_time`, 진행 수를 저장하고 마지막 전체 수집 성공 시각은 유지한다. 완전한 마지막 챔피언까지 모았으면 최종 검증과 후보 생성을 진행한다. dry-run에는 저장을 가장한 정상 재개 상태를 반환하지 않는다.
- [x] 기존 상태 JSON에 기록한 진행 수로 관리자 카드에 ‘158/173명 수집, 다음 실행에서 계속’을 표시한다. 실제 오류와 quota 동작은 별도로 유지하고 lease는 항상 해제한다.
- [x] checkpoint 저장 실패, 원본 버전 변경, progress 해시 불일치, 최종 후보 생성 실패가 여전히 오류로 남는지 확인한다. `tests/lol-mayhem-admin-ux.test.ts`에도 진행·실패 표시 구분을 검증한다.
- [x] 관련 테스트와 `npm run verify:core`를 실행한다. 실제 재개와 완성본 자동 공개는 별도 운영 검증 단계로 남긴다.

## 작업 2 검토 근거를 이용한 현재 등장 상태 구분

주요 대상: 신규 `lib/lol/mayhemAvailability.ts`, `lib/lol/augments/catalog.ts`, `lib/lol/mayhemReviewedDataset.ts`, `lib/lol/mayhemArchive.server.ts`, `lib/lol/mayhemDatasetStore.server.ts`.

연결 확인 대상: `lib/lol/augments/catalog.server.ts`, `lib/lol/mayhemObservationHistory.server.ts`, `lib/lol/mayhemMappingReview.ts`, 챔피언 증강 화면, 조합 제보의 선택 목록·서버 검증. 필요하면 현재 사용 가능한 목록과 원본 전체 목록을 별도로 전달한다.

인터페이스: `getMayhemAvailabilityOverride(patch:string, platformId:number)`는 해당 패치의 검토 기록이 있으면 `{status:'unverified', reason:string, sourceUrl:string}`를 반환하고 없으면 `null`을 반환한다. 원본 타입과 공식 활성 상태는 유지한다.

- [x] 신규 `tests/lol-mayhem-availability.test.ts`에 12개 ID의 16.22 적용, 재장전 미적용, 16.21·미래 패치 미적용을 검증한다.
- [x] 공통 규칙을 기본 도감·추천 조합·선택률에 적용한다. 이미 공개된 자료도 조회 시 같은 판정을 적용하고, 포함된 조합 전체를 기본 추천에서 뺀다. 보관함은 파일 해시와 기존 스키마를 먼저 검증한 뒤 복사본의 상태·사유와 조합 상태를 함께 계산한다.
- [x] 신규 검수 후보를 만들 때도 같은 상태 판정을 적용한다. 공식 목록·승인 연결 행을 삭제하지 않고 현재 추천에 쓸 행만 고른다. 자동 공개의 수량 감소 보호와 관리자 미연결 판정도 대조한다.
- [x] 관측 이력은 필터링 전 공식 목록을 사용해 12개가 검색·이력에서 사라지지 않게 한다. 과거 패치 순위와 보관함의 과거 자료는 보존한다. 캐시 버전과 태그를 검토해 배포 뒤 과거 ‘사용 중’ 상태가 남지 않게 한다.
- [x] `tests/lol-mayhem-catalog.test.ts`, `tests/lol-mayhem-archive-store.test.ts`, `tests/lol-mayhem-mapping-review.test.ts`, `tests/lol-mayhem-observation-store.test.ts`, `tests/lol-mayhem-tips.test.ts`, 관련 공개 API 테스트로 원본 보존·기본 추천 제외·과거 이력 보존을 확인한다. 변경된 공개 응답·정규화 계약은 운영 문서에 반영한다.

## 통합 확인과 운영 검증

- [x] 전체 변경 후 `npm run verify:core`와 `npm run test:unit`을 실행한다. 순수 표시·수집 코드 변경이면 migration 검증은 대상이 아니며, SQL/RPC 변경이 필요해지면 계획을 갱신한다.
- [x] `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-mayhem-browser.test.ts`의 기존 fixture를 확장한다. `375x667`, `390x844`, `430x932`, `1440x900`에서 기본 목록 제외, 확인 중 보관함 검색, 중단 추정 사유, 관측 이력, 관리자 수집 진행을 확인한다. 뷰포트 검증과 실기기 검증을 구분한다.
- [ ] 운영 적용 시 기존 progress와 공개 포인터를 다시 읽고, 수집 완료 후에만 후보·자동 공개 결과를 확인한다. 근거 범위와 실제 공개 페이지 반영도 읽기 조회로 확인한다. 수집 실패 상태가 사라졌다는 이유만으로 새 자료 공개 성공이라고 보고하지 않는다.


## 검증 기록

- LoL 단위 테스트: `npx vitest run tests/lol-*.test.ts --maxWorkers=1 --testTimeout=15000 --hookTimeout=30000` — 94파일, 1,039개 통과. 조건부 9파일·167개 생략.
- 브라우저: 시스템 Chrome의 격리 프로필과 기존 fixture에서 `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-mayhem-browser.test.ts` — 50개 통과. `375x667`, `390x844`, `430x932`, `1440x900`에서 확인했다. 새 등장 상태와 관리자 진행 화면의 스크린샷도 확인했다. 실기기·실제 운영 API 검증과는 구분한다.
- [PR CI 첫 실행](https://github.com/ka6865/BGMS/actions/runs/43983593558): Node 22에서 `verify:core`, 전체 Vitest 520파일, Jest 2스위트·4개, 격리 migration, 운영 의존성 감사 통과. lint는 기존 43개 경고·오류 0건이다.
- 로컬 전체 단위 테스트 4 worker 실행은 시간 초과가 다수 발생해 중단했다. 단일 worker LoL 재검증과 위 CI 전체 검증으로 대조했다. 로컬 push 훅의 정적 검증도 지연돼 훅에 명시된 `SKIP_PRE_PUSH=1` 경로를 사용했으며 동일 검증을 CI에서 통과했다.
- 별도 코드 리뷰: 지적 사항 없음. 원본 DB/Storage 변경·수집 재실행·배포·병합은 수행하지 않았다.
