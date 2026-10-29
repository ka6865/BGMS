# LoL Riot 키 교체 절차 (개발 키 → 프로덕션 키, 2026-10-30)

프로덕션 키를 받은 뒤 서비스가 키 교체만으로 동작하도록 준비한 내용과 교체 순서다. 신청 준비 항목은 [Production Key 준비 점검](../plans/2026-10-23-lol-production-key-readiness.md)을 따른다.

## 키 교체로 바뀌는 것과 바뀌지 않는 것

- **호출 한도**: 코드 수정이 필요 없다. 공유 호출 제한(`reserve_lol_riot_request`)은 Riot 응답 헤더 `X-App-Rate-Limit`을 읽어 구간별 한도를 맞춘다(헤더를 아직 못 봤으면 개발 키 값 `20:1,100:120`으로 시작). 프로덕션 시작 한도는 리전별 10초 500회, 10분 30,000회다([Riot Developer Portal](https://developer.riotgames.com/docs/portal)).
- **동시 요청 수(선택 조정)**: 기본값은 개발 키 기준이다. 한도가 커지면 아래 값을 올릴 수 있다.

  | 설정 | 위치 | 기본 | 범위 | 의미 |
  | --- | --- | --- | --- | --- |
  | `LOL_RIOT_PARALLEL_REQUESTS` | 환경 변수 | 6 | 1~32 | 서버 프로세스 하나가 동시에 보내는 Riot 요청 수 |
  | `LOL_MATCH_LOAD_CONCURRENCY` | 환경 변수 | 5 | 1~20 | 검색 한 번에 동시에 받는 경기 상세 수 |
  | `lol_rate_limit_state.max_concurrency` | DB(호스트 행 `asia`, `kr`) | 8 | 1~32 | 모든 서버를 합친 호스트별 동시 Riot 요청 수 |

- **PUUID(확인 필요)**: Riot 암호화 ID는 프로젝트(키)마다 다르게 나올 수 있다는 커뮤니티 문서가 있다([Riot API Libraries](https://riot-api-libraries.readthedocs.io/en/latest/ids.html), Riot 공식 문서 아님). 같은 개발 키를 재발급한 경우에는 바뀌지 않았다(2026-10-30 확인: 저장 계정 4개 모두 같음, 가장 오래된 저장은 6일 전). 개발 키에서 프로덕션 키로 바꿀 때는 아래 점검으로 확인한다.

## 교체 순서

1. 프로덕션 키를 받으면 먼저 **로컬에서 읽기 전용 점검**을 한다. DB와 Riot을 읽기만 하고 PUUID·키를 출력하지 않는다.

   ```bash
   RIOT_API_KEY=<프로덕션 키> npx tsx scripts/lol_check_key_puuid.ts --limit=3
   ```

   - `verdict: "same"`(종료 코드 0): 저장 데이터를 그대로 쓴다. 2단계로 간다.
   - `verdict: "different"`: 새 키로 운영하지 않는다. 저장 계정·요약·랭크 이력·보관본·참가자 ref가 모두 PUUID를 쓰므로 정리 방법(전체 비우기 또는 검색 계정만 다시 조회해 옮기기)을 먼저 정한다. 삭제는 별도 승인과 dry-run을 거친다.
   - `verdict: "inconclusive"`: 이름 변경(404)이나 일시 실패만 있었다. `--limit`을 늘려 다시 확인한다.
2. 배포 환경의 `RIOT_API_KEY`를 프로덕션 키로 바꾸고 재배포한다. 서버 시작 환경에 이전 키가 남아 있으면 파일보다 우선하므로([검색 오류 검토](../plans/2026-10-22-lol-search-error-review.md)) 상속 값을 지우고 재시작한다.
3. 검색 1회 뒤 운영 패널에서 `riot_success` 증가와 `riot_429`·`riot_key_error`가 없는지 확인한다. 헤더 기록(`lol_rate_limit_state.app_rate_limit`)이 프로덕션 한도로 바뀌었는지 본다.
4. (선택) 동시 요청 수를 올린다. 예: `LOL_RIOT_PARALLEL_REQUESTS=12`, `LOL_MATCH_LOAD_CONCURRENCY=10`, `update public.lol_rate_limit_state set max_concurrency=16 where host in ('asia','kr')`. 올린 뒤에도 `riot_429`가 생기면 되돌린다.

## 되돌리기

`RIOT_API_KEY`를 이전 키로 되돌리고 재배포한다. 1단계에서 `same`이었다면 데이터 변경이 없으므로 다른 조치는 없다. 동시 요청 수를 올렸다면 기본값으로 되돌린다.

## 검증

- `tests/lol-check-key-puuid.test.ts`: 같음·다름·404·일시 실패 판정, 결과에 PUUID 미포함.
- 2026-10-30 현재 개발 키로 `scripts/lol_check_key_puuid.ts --limit=2` 실행: `same` 2건.
