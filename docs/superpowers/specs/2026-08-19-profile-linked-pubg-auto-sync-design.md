# 프로필 연동 PUBG 자동 갱신 안정화 설계

## 목적

일반 전적 검색은 DB 데이터만 읽고, 자동 PUBG API 갱신은 프로필에 PUBG 닉네임을 연동한 최근 활동 회원으로 제한한다. 프로필 수정 시각을 동기화 시각으로 오용하지 않고, 수동 갱신과 GitHub Actions 자동 갱신이 같은 플레이어를 동시에 갱신하지 않도록 한다.

## 현재 문제

- 프로필 연동 사용자는 `profiles.updated_at`이 10일 이상 지났는지로 후보를 고른다. 이 값은 프로필 수정 시각이며 전적 갱신 완료 시각이 아니다.
- 자동 갱신이 완료되어도 `profiles.updated_at`은 바뀌지 않아 같은 오래된 프로필이 반복 선택될 수 있다.
- `search_count >= 3`인 일반 검색 유저도 자동 갱신 2순위로 포함되어 API 예산을 사용한다.
- 프로필 연동 사용자는 최근 사이트 활동 여부를 검사하지 않는다.
- 자동 갱신 상태, 연속 실패 수, 다음 재시도 가능 시각이 영속화되지 않는다.

## 제품 정책

### 일반 검색

- 기존 DB 유저 검색은 `pubg_player_cache`, `pubg_player_matches`, `processed_match_telemetry`만 사용한다.
- 일반 검색만으로 자동 갱신 후보가 되지 않는다.
- 검색량 기반 자동 갱신 2순위는 제거한다.
- 사용자가 직접 누르는 `전적 갱신`은 연동 여부와 무관하게 기존 쿨다운 안에서 허용한다.

### 자동 갱신

다음 조건을 모두 만족한 회원만 대상이다.

1. `profiles.pubg_nickname`이 비어 있지 않다.
2. `profiles.pubg_platform`이 지원 플랫폼이다.
3. `profiles.last_active_at`이 최근 30일 이내다.
4. 마지막 성공 갱신 후 24시간이 지났거나 성공 이력이 없다.
5. 실패 백오프의 `next_eligible_at`에 도달했다.
6. 실행 중 lease가 없거나 만료됐다.

하루 실행 상한은 초기 15명으로 유지하되, PUBG API 남은 호출량과 429 신호가 우선한다.

## 데이터 모델

새 내부 테이블 `public.pubg_linked_player_sync_state`를 둔다. 동기화 대상은 회원이 아니라 PUBG 플레이어 identity이므로, 여러 회원이 같은 PUBG 닉네임을 연동해도 한 번만 갱신한다.

```sql
platform text not null
normalized_nickname text not null
display_nickname text not null
status text not null
last_attempt_at timestamptz
last_success_at timestamptz
next_eligible_at timestamptz
consecutive_failures integer not null default 0
last_error_code text
lease_token uuid
lease_expires_at timestamptz
updated_at timestamptz not null default now()
primary key (platform, normalized_nickname)
```

허용 상태는 `idle`, `running`, `success`, `failed`, `invalid_nickname`, `rate_limited`다.

- exposed `public` schema이므로 RLS를 켠다.
- `anon`, `authenticated` 권한은 회수한다.
- `service_role`만 읽기·쓰기를 허용한다.
- 사용자의 프로필 화면에는 이 내부 테이블을 직접 노출하지 않는다.

프로필의 PUBG 닉네임 또는 플랫폼이 바뀌면 새 player identity가 별도 후보가 된다. 더 이상 어떤 프로필에서도 참조하지 않는 sync state는 30일 후 정리한다.

## 후보 선정과 claim

후보 조회는 프로필을 player identity로 그룹화한 뒤 sync state와 조인한다. 같은 PUBG 닉네임을 연동한 회원이 여러 명이면 가장 최근 `last_active_at`을 대표 활동 시각으로 사용한다.

```text
pubg_nickname 존재
AND max(last_active_at) >= now - 30 days
AND (next_eligible_at IS NULL OR next_eligible_at <= now)
AND (status != running OR lease_expires_at <= now)
ORDER BY last_success_at NULLS FIRST, last_success_at ASC, max(last_active_at) DESC
LIMIT 15
```

각 후보는 처리 전에 service-role RPC로 lease를 원자적으로 claim한다. claim 입력에는 canonical platform/nickname, 표시 nickname, 새 `lease_token`, 만료 시각이 포함된다. 더 이상 활성 프로필이 해당 identity를 참조하지 않거나 유효한 lease가 있으면 claim은 실패한다.

## 수동 갱신과의 충돌 방지

기존 `public.pubg_refresh_locks`와 `claim_pubg_force_refresh`를 공통 플레이어 잠금으로 재사용한다. 현재 response cache key에는 시즌이 포함될 수 있으므로, 잠금에는 시즌과 무관한 `refresh:{platform}:{normalizedNickname}` 전용 key builder를 사용한다.

- 수동 갱신: `refresh:{platform}:{normalizedNickname}` lock을 claim한다.
- 자동 갱신: 동일한 lock key를 claim한 뒤에만 PUBG API를 호출한다.
- 자동 작업은 수동 갱신보다 우선하지 않는다. lock을 얻지 못하면 해당 후보를 실패 처리하지 않고 다음 실행으로 넘긴다.
- linked-player sync lease는 후보 실행 소유권을, refresh lock은 플레이어 API 중복 호출 방지를 담당한다.

## 실행 흐름

1. eligible linked-player 후보를 조회한다.
2. linked-player sync lease를 claim한다.
3. 공통 player refresh lock을 claim한다.
4. PUBG player API에서 최근 match ID를 조회한다.
5. `pubg_player_matches`에 없는 ID만 계산한다.
6. 신규 매치를 최신순 최대 10개까지 순차 수집한다.
7. 결과 상태를 기록하고 lease를 해제한다.

신규 매치가 0개여도 정상적인 동기화 성공으로 기록한다. 이 경우 `last_success_at`과 `next_eligible_at = now + 24 hours`를 갱신한다.

## 오류와 백오프

| 상황 | 상태 | 다음 대상 시각 | 전체 작업 |
|---|---|---|---|
| 성공·신규 0개 | success | 24시간 후 | 계속 |
| 성공·신규 저장 | success | 24시간 후 | 계속 |
| 플레이어 404 | invalid_nickname | 7일 후 | 계속 |
| PUBG 429 | rate_limited | API reset 이후, 불명확하면 1시간 후 | 즉시 중단 |
| 네트워크·5xx 1회 | failed | 1시간 후 | 계속 |
| 연속 실패 2회 | failed | 6시간 후 | 계속 |
| 연속 실패 3회 이상 | failed | 24시간 후 | 계속 |
| refresh lock 충돌 | 기존 상태 유지 | 다음 스케줄 | 계속 |

실패 후 성공하면 `consecutive_failures`와 `last_error_code`를 초기화한다.

## GitHub Actions 정책

- Smart Scraper와 Bluezone 작업 뒤의 저우선 사용자 sync 위치는 유지한다.
- 후보는 프로필 연동·최근 활동 회원만 조회한다.
- 사용자별 PUBG 호출 전 최근 `pubg_api_status`를 확인한다.
- 429 또는 안전 잔여량 이하가 되면 즉시 중단한다.
- 자동 sync가 429를 기록하면 Hotdrop을 건너뛰는 현재 보호 로직을 유지한다.
- 일반 검색량 기반 cache 후보는 제거한다.

## 사용자 화면

- 기존 유저 검색은 DB 전적과 최근 업데이트 시각을 즉시 표시한다.
- 자동 갱신 때문에 검색 화면을 로딩 상태로 바꾸지 않는다.
- 수동 `전적 갱신`만 버튼 로딩과 성공·실패 메시지를 표시한다.
- 연동 닉네임이 404로 반복 실패한 경우 프로필 화면에서 닉네임 재확인을 유도하는 기능은 후속 범위로 둔다.

## 관측성과 운영 지표

자동 sync 실행마다 다음을 남긴다.

- 후보 수, claim 성공 수, lock 충돌 수
- 성공 사용자 수, 신규 저장 매치 수
- 404, 429, 네트워크/5xx 실패 수
- 처리 시간과 중단 사유
- 다음 eligible 시각

닉네임이나 account ID 원문은 운영 오류 로그에 남기지 않고 기존 fingerprint 정책을 유지한다.

## 테스트 기준

- 프로필 연동 + 최근 활동 + stale sync만 후보가 된다.
- 일반 검색 고빈도 cache 유저는 후보가 되지 않는다.
- 오래된 `profiles.updated_at`만으로 후보가 되지 않는다.
- 성공·신규 0개도 24시간 성공 상태를 기록한다.
- 404는 7일 백오프, 429는 전체 중단을 만든다.
- 연속 실패가 1시간·6시간·24시간으로 증가한다.
- 동일 player identity lease와 수동 refresh lock이 중복 호출을 막는다.
- 같은 PUBG 닉네임을 연동한 프로필이 여러 개여도 후보는 한 번만 나온다.
- 프로필 nickname/platform 변경 시 새 identity가 후보가 되고 미참조 상태는 정리된다.
- Daily workflow는 429 후 Hotdrop을 실행하지 않는다.

## 비범위

- PUBG가 이미 제공하지 않는 과거 매치 복원
- 비연동 일반 검색 유저의 자동 갱신
- AI 분석 자동 실행
- 프로필 UI에 자동 갱신 설정 토글 추가
