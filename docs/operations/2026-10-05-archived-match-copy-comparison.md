# R2 경기 사본 비교 도구

`scripts/audit_archived_match_copies.ts`는 R2·DB에 접속하지 않는 오프라인 비교 CLI다. 기존 retention snapshot, 분류표, 조건부 pair 계획의 메타데이터와 표본 본문 SHA-256을 대조한다. 새 본문이 필요하면 별도 read-only 작업이 가져온 정확한 바이트 파일을 최대 20개까지 받는다. 이 CLI에는 자격 증명 읽기, R2 요청, DB 요청, 삭제·수정 경로가 없다.

## 오프라인 실행

모든 private 입력은 POSIX에서 mode `0600`이어야 한다. inventory snapshot은 최대 96 MiB, 조건부 계획은 32 MiB, 분류표와 각 표본 snapshot은 64 MiB다. 전체 입력 한도는 256 MiB다. inventory는 최대 100페이지·100,000개 객체, 계획은 최대 10,000쌍이며 비교는 최대 120초로 제한한다. 페이지·행 수 불일치, 실패한 snapshot, 중복 키, DB 테이블 행 수 불일치는 불완전 입력으로 처리한다.

```bash
npx tsx scripts/audit_archived_match_copies.ts \
  --snapshot /private/run/private.json \
  --plan /private/run/conditional-plan-private.json \
  --classified /private/run/classified-private.json \
  --sample-snapshot /private/content-run/private.json \
  --sample-snapshot /private/final-run/private.json \
  --manifest /private/output/archived-copy-comparison.json
```

stdout에는 건수와 차단 사유 집계만 출력한다. pair별 키·ETag·SHA와 판단은 `--manifest` 파일에 저장하며 기존 파일을 덮어쓰지 않고 mode `0600`으로 만든다. 출력 경로의 상위 폴더는 미리 만들어 둔다. private manifest를 공유 로그나 artifact에 올리지 않는다.

기존 표본의 ETag·크기만 같아도 중복으로 판정하지 않는다. 본문 SHA-256이 두 사본 모두에 있어야 exact-byte 비교를 표시한다. 기존 snapshot에 SHA가 있어도 현재 R2를 다시 읽은 증거로 승격하지 않는다. 본문이 포함되지 않은 표본은 JSON 배열 구조나 공통 원본 변환을 입증하지 않는다.

## 선택적인 새 본문 증거

상위 read-only 검증 작업이 실제 R2 GET의 바이트를 mode `0600` 파일로 보관한 경우 `--fresh-bytes`로 전달할 수 있다. manifest와 각 body 파일은 manifest가 있는 디렉터리 아래에 두며 상대 경로만 허용한다. manifest는 mode `0600`이어야 하고 아래 필드를 갖는다.

```json
{
  "version": 1,
  "readOnly": true,
  "complete": true,
  "observedAt": "2026-10-05T03:00:00.000Z",
  "objects": [
    {
      "key": "private-object-key",
      "etag": "observed-etag",
      "bytes": 12345,
      "file": "bodies/object-01.bin",
      "contentEncoding": "gzip"
    }
  ]
}
```

`observedAt`은 실행 시점 기준 24시간 이내여야 한다. 각 객체는 최대 32 MiB, body 합계는 128 MiB다. key·ETag·길이가 입력 inventory와 다르면 그 객체의 읽기 증거를 사용하지 않는다. 비교 대상 pair와 공통 원본 envelope도 각각 객체 한 개로 계산해 전체 GET 대상을 20개로 제한한다. `gzip`, `br`, identity body를 읽을 수 있고 압축 해제 결과는 128 MiB로 제한한다.

## 판정 기준

- `legacy-byte-duplicate`는 본문 전체 SHA가 같아야 동일 바이트 사본이다. 새 공통 source envelope는 `sharedTelemetrySourceContract`로 checksum, 공식 match ID/platform, 전체 participant·roster 연결, 기본 스탯과 허용 이벤트를 검증한다. 대상 계정이 공식 participant와 DB match metadata에 연결되고, 양쪽 기존 이벤트가 그 공통 source 안에서 확인돼야 `commonSourceConversionProvenPairs`에 포함한다.
- `projection: "full"`인 player별 분석 envelope는 경기 전체 source 보존 증거로 사용하지 않는다. 같은 SHA여도 공통 source 확인과 기존 recovery 별칭 소비 확인이 별도다.
- `superseded-map`은 match/platform/player/mode와 버전 순서를 확인한다. 새 본문이 있으면 두 telemetry payload identity도 검증한다. 현재 registry 참조가 남아 있으면 차단하고, 참조가 snapshot에서 보이지 않아도 live DB·lease 재확인이 끝난 것으로 보지 않는다.
- 모든 종류에 현재 본문 read와 recalculation proof가 필요하다. 현재 CLI에는 recalculation을 검증하는 입력 계약이 없으므로 `recalculationVerified`와 `deletionEligible`은 항상 `false`, `deletionEligibleCandidates`는 항상 0이다. 이 도구의 결과는 삭제 승인이나 대상 목록이 아니다.

`report.complete`, inventory 개수/바이트, 모든 DB metadata 행 수, classification과 pair 계획이 맞지 않으면 전체 증명 수는 0이다. pair별 SHA가 없거나 충돌해도 0으로 남는다. 이 도구는 live proof나 운영 정리를 대신하지 않는다.
