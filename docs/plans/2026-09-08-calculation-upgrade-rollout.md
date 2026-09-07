# 전체 이용자 계산 갱신

## 범위와 재개

`run_calculation_upgrade_rollout.ts`는 Steam/Kakao의 필터 8·모집단 1을 충족한 official/competitive BR 비교 표본 중 구 계산 행을 조회한다. 상한 ID를 고정한 keyset 조회로 identity 스냅샷을 저장하고, 실제 경기 단위로 원본을 재사용한다. 적용하면서 줄어드는 pending 목록에 OFFSET을 계속 더하지 않는다.

```bash
# 읽기 전용 재고 고정. DB/원본 다운로드 쓰기 없음, 로컬 inventory/state만 생성.
npx tsx scripts/run_calculation_upgrade_rollout.ts

# 기본 한 번의 실행: 최대 25경기/512MiB/10분. 다운로드와 적용은 명시해야 한다.
npx tsx scripts/run_calculation_upgrade_rollout.ts --apply --acquire-raw

# 전체 갱신을 승인받은 운영 예시. 한 경기/한 CAS씩 순차 실행한다.
npx tsx scripts/run_calculation_upgrade_rollout.ts --apply --acquire-raw \
  --max-matches 5000 --max-source-mib 128 \
  --max-download-mib 256000 --max-runtime-minutes 720
```

같은 output-dir로 실행하면 고정 inventory와 state의 다음 경기부터 재개한다. snapshot hash·project·version·진행 순서·카운터를 검증하며 lock이 있으면 동시 실행을 거부한다. 새로 유입된 경기는 기존 inventory에 끼워 넣지 않는다. 완료 후 새 output-dir로 후속 목록을 만들 수 있다.

## 단계별 보장

1. 메타데이터로 canonical 버전을 확인한다. v72 등 별도 구 버전이나 canonical 누락은 별도 분류하며 이 RPC로 버전만 바꾸지 않는다.
2. 기존 로컬 공식 원본을 먼저 사용한다. 없으면 해당 경기의 공식 match와 telemetry만 다운로드한다. HTTPS PUBG 호스트·identity·BR 유형을 확인하고 redirect는 거부한다. R2 지도 projection을 원본으로 쓰지 않는다.
3. 소규모 기본 상한은 32MiB이다. 큰 실제 경기에는 운영자가 명시한 최대 128MiB telemetry 상한을 사용한다. 경기 metadata는 최대 2MiB, 디스크 여유가 512MiB 미만이면 중단한다.
4. 기존 prepare가 원본/full projection의 전체 계산 일치와 benchmark 전체 snapshot을 검증한다. benchmark의 user/scraper 출처를 보존한다. 경기당 10행을 넘으면 같은 경기에서 deferred 행을 계속 처리한다.
5. 기존 apply runner의 단일 CAS와 저장 후 재조회 검증을 이용한다. 결과가 불명확하면 전체 진행을 멈추고 해당 checkpoint로 재개한다. 계산/원본 검증 실패를 성공으로 삼지 않는다.
6. job에서 새로 다운로드한 scratch 원본만 검증 결과·진행 상태 저장 후 제거한다. 기존 catalog 원본, DB 데이터, R2 객체는 삭제하지 않는다. manifest/checkpoint와 분류 결과는 남긴다.

공식 match 404, telemetry 403/404는 해당 경기의 공식 원본 미확보로 기록하고 다음 경기를 처리한다. 인증 오류·429·5xx·시간 초과·계산 불일치·쓰기 경합은 중단 사유다. 원본을 확보하지 못한 행은 기본 전적을 유지하고 전술 지표를 보류한다.

## 분모와 한계

- 2026-09-08 최초 고정 inventory: 플레이어·경기 4,799행, 실제 4,087경기. 이는 전체 processed 저장 14,397행과 다르다.
- 기존 benchmark가 없는 행, 이전 canonical 버전, 적격 모집단 밖의 전적은 이 갱신 RPC의 대상이 아니다. 별도 집계와 적격 여부 검증 후 처리해야 하며 완료 수에 포함하지 않는다.
- Gemini 호출과 AI 캐시 일괄 재생성, R2 쓰기는 하지 않는다.
- 다운로드 집계는 정상 수신한 바이트다. 최초 32MiB 제한으로 취소된 응답처럼 중간에 차단한 전송은 실제 네트워크 사용량에 추가될 수 있다.
- 소규모 안전 점검을 통과한 뒤에도 총 작업 시간은 대상 경기의 원본 크기와 실제 DB/다운로드 속도에 따라 달라진다.
