# 리플레이 적 좌표 전체 보존과 track 저장 형식 — 2026-10-16

## 문제

공개 리플레이(`lite`)는 전송량을 줄이려고 적 좌표를 1/10로 축소했다. 위치 로그가 선수별로 약 10초 간격이라, 적은 약 100초마다 꺾이는 직선으로 움직였다. 크기의 대부분은 좌표 수가 아니라 이벤트 객체 형식에서 나왔다. 좌표 하나마다 `type`·`time`(ISO 문자열)·`name`·`teamId`·`isTeam` 키가 반복된다.

## 변경

- `lite` 리플레이도 적 좌표를 모두 보낸다(`sampleReplayPositions` 제거). 분석 입력은 이전과 같이 `full` 투영을 쓴다.
- R2에 저장하는 리플레이 JSON은 `serializeTelemetryPayload`(`lib/pubg-analysis/replayTrackEncoding.ts`, encoding v1)로 만든다.
  - 좌표 이벤트를 선수별 열 배열 `tracks[]`(`t`·`x`·`y`·`z`·`hp`·`veh`)로 묶는다. `events`의 원래 자리에는 track 번호만 남겨 순서를 그대로 복원한다.
  - `time`이 `encoding.timeBaseMs + relativeTimeMs`와 같을 때만 생략한다. 투척물 폭발처럼 값이 다른 이벤트는 `time`을 유지한다.
  - 규칙에 맞지 않는 좌표(키 구성·타입·시간 불일치)는 일반 이벤트로 남는다. `time`이 없는 이벤트가 하나라도 있으면 압축하지 않고 기존 형식으로 저장한다.
- `parseTelemetryPayload`는 `encoding`이 있으면 track 형식을 원래 이벤트 배열로 풀고, 없으면 기존 형식을 그대로 읽는다. 브라우저·3D·스쿼드 지도·스크립트는 모두 이 함수를 거치므로 소비자 코드는 바뀌지 않는다.
- 2D 리플레이의 좌표 공백 보간 기준(`MAX_POSITION_INTERPOLATION_GAP_MS`, 150초)은 유지한다. 새 데이터의 정상 간격은 12초 이하이고 12~150초 공백은 확인한 두 경기에 없었다. 기존 lite 캐시(약 100초 간격)가 남아 있는 동안 적 보간이 끊기지 않게 하려는 값이다.

학습용 리플레이(`2026-09-22` squad·solo)로 잰 크기는 다음과 같다(Node `zlib.gzipSync` 기본값).

| 형식 | squad 원본 / gzip | solo 원본 / gzip |
| --- | ---: | ---: |
| 기존 full(전체 좌표, 객체 배열) | 3,003KB / 338KB | 1,954KB / 243KB |
| 기존 lite(적 좌표 1/10, squad만 측정) | 2,183KB / 213KB | - |
| encoding v1(전체 좌표) | 2,059KB / 242KB | 1,146KB / 170KB |

같은 두 경기에서 기존 lite 좌표로 보간한 적 위치는 실제 위치와 중간값 45~66m, 상위 10%는 1.5km 이상 어긋났다(적 1명당 무작위 시각 200개 비교).

두 경기 모두 인코딩 후 디코딩한 결과가 원본 이벤트 배열과 JSON 문자열까지 같다(`tests/replay-track-encoding.test.ts`).

## 캐시 버전

`TELEMETRY_VERSION`은 올리지 않는다(62 유지). 이 값은 리플레이 캐시뿐 아니라 경기 분석용 텔레메트리 캐시, 조우 기록, 무기 메타 백필, 벤치마크 복구, 정리 스크립트의 기준 버전이다. 올리면 분석 캐시가 모두 무효화되고, PUBG 원본 보존 기간(14일)이 지난 경기는 다시 계산할 수 없다.

따라서 배포 뒤 **새로 만들어지는** 리플레이 캐시부터 새 형식과 전체 적 좌표가 적용된다. 이미 저장된 리플레이는 기존 형식 그대로 읽히고 적 좌표도 축소된 상태로 남는다.

## 운영 확인 시 주의

`scripts/verify_archived_match_reads.ts`와 `scripts/verify_legacy_match_copies.ts`는 다시 계산한 리플레이와 저장된 리플레이를 엄격하게 비교한다. 이 변경 **전에** 저장된 리플레이는 적 좌표가 축소돼 있으므로 `archive-verification-replay-content-mismatch`가 나는 것이 정상이다. 배포 뒤 새로 생성된 리플레이로 확인한다.
