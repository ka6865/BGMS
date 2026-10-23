# LoL 검색 502 / Riot 401 오류 검토

2026-10-22. 조정자 검토 및 로컬 실행 환경 복구 기록이다. 제품 코드 수정은 Orca의 Luna가 수행했다.

## 확인된 원인과 변경

- 기존 `lib/lol/riotSearch.server.ts`는 Riot HTTP 401을 일반 `upstream` 오류로 분류했다. `app/api/admin/lol/search/route.ts`에서 이를 502와 “Riot API에 일시적인 문제가 있습니다.”로 표시했다.
- 사용자 재시도에서 실제 Next 서버가 Account-V1의 HTTP 401을 받는 것을 안전한 진단 로그로 확인했다. 이 요청은 본문 취소 실패가 아니었다.
- 서버 시작 환경의 Riot 키와 현재 worktree `.env.local` 키가 서로 달랐다. 설치된 `@next/env`의 `loadEnvConfig`/`processEnv`는 초기 환경 변수 값을 파일보다 우선한다. 파일의 `Reload env` 로그만으로 키 교체 완료를 판정해서는 안 된다.
- Luna가 401/403을 키·권한 오류로 분류하고, 응답 본문 취소 실패가 원래 오류 분류와 429 대기 시간을 덮지 않도록 보완했다. 후자는 회귀 테스트로 확인한 별도 오류 처리 보완이며 이번 실제 401의 원인은 아니다.
- 서버 진단은 고정 endpoint 분류, 처리 단계, 오류 종류, 허용된 원인 코드, HTTP 상태, 소요시간만 남긴다. 키·Riot ID·PUUID·요청 URL·원본 본문·임의 오류 메시지는 기록하지 않는다.

## 로컬 서버 복구

기존 서버의 포트·작업 폴더·실행 명령을 확인한 후 동일 worktree의 `127.0.0.1:59405`로 재시작했다. 원본 checkout의 Supabase URL·익명 키·service role 설정이 기존 서버 설정과 일치하는지 값 비출력 비교로 확인했다. 새 서버에는 `RIOT_API_KEY`를 시작 환경으로 주입하지 않고 worktree `.env.local`에서 읽도록 했다. 키 파일 권한은 `600`이다.

후속 키 교체도 같은 원칙을 따른다. 키를 명령 인자에 쓰거나 원본 checkout에 복사하지 않는다. 현재 파일 키의 API 유효성과 실제 관리자 로그인 경로의 성공은 환경 설정 일치만으로 단정하지 않는다.

## 검증 결과

- `npx vitest run tests/lol-riot-search.test.ts tests/lol-dev-access.test.ts tests/lol-dev-status.test.ts tests/supabase-guard-bearer.test.ts`: 4개 파일, 66개 테스트 통과.
- `npm run verify:core`: 종료 코드 0. ESLint 오류 0개, 기존 경고 47개, TypeScript 통과.
- 재시작 후 익명 `/api/admin/lol/status`는 401로 차단된다.
- 새 서버 시작 환경에 상속된 Riot 키가 없는 것을 확인했다.
- 재시작 후 실제 관리자 검색에 대해 사용자가 “잘보임”으로 정상 표시를 확인했다. 재시작 이후 서버 로그에서도 검색 POST 200 응답 1건과 Riot 오류 진단 0건을 확인했다. 조정자는 로그인 쿠키를 읽거나 인증을 우회하지 않았고 실제 Riot 검색을 중복 실행하지 않았다.
- UI는 변경하지 않아 이번 수정에서 모바일 브라우저 검사를 반복하지 않았다. 배포·커밋·DB/R2 변경은 없다.

## Orca 실행 상태

작업 `task_eda45f0e1a7c`, Dispatch `ctx_6f84750ef2d1`의 Luna가 사용량 한도로 중단됐다. 코드 수정은 보존했으며 작업자가 완료 보고한 것으로 처리하지 않았다. Dispatch는 프로세스 종료 없이 `abandoned`, Task는 한도 중단 사유로 `failed`를 기록했다. 조정자가 남은 코드 검증과 로컬 서버 재시작을 수행했으며 추가 모델은 실행하지 않았다.
