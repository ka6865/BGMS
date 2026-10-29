# Daily BGMS Maintenance 안정화

작성일: 2026-10-30. 코드와 로컬 테스트 변경 기록이며 운영 실행 기록이 아니다. `Run Smart Scraper` 단계와 `scripts/scrape_elite.ts`는 이 변경 범위가 아니다.

## 변경 계약

| 항목 | 이전 | 이후 |
| --- | --- | --- |
| 예약 시각 | `0 18 * * *`(정각). 10월 실제 시작 KST 05:20~07:30 | `41 17 * * *`(KST 02:41). 다른 워크플로 예약 분과 겹치지 않음을 테스트로 고정 |
| 잡 순서 | 고객센터 첨부 정리는 비활성 게시판 이미지 정리 뒤, maintenance 는 쓰기 제한 정리 뒤 | 세 잡 병렬. maintenance 안의 백업 → 정리, Scraper → Bluezone → Sync → Hotdrop 순서는 유지 |
| 데이터 품질 감사 | `data` jsonb 전체를 `updated_at` 정렬로 1,000행씩 조회 | 식별자만 `created_at` 인덱스 순서로 읽고 fullResult 세 경로만 `match_id` 기준 100행씩 조회. 기간 안에 갱신만 된 행은 별도 소량 조회 |
| 감사 실패 표시 | continue-on-error 로 조용히 성공 | `::warning`, 단계 출력 `status`·`mismatch_count`, 일일 Discord 보고의 `주의:` 줄 |
| 자기장 수집 | 조회 실패·429 한 건이면 그날 추출분 전체 폐기 | 성공분을 저장한 뒤 경고와 함께 실패 종료. 실패한 매치는 다음 실행에서 재시도 |
| 저장소 정리 단계 | `Run Storage Cleanup`, R2 쓰기 자격증명·`CLEANUP_TARGET_VERSION`·`CLEANUP_RETENTION_DAYS` 전달, 실제로는 no-op + 플레이어 캐시 압축 | `Compact Inactive PUBG Player Cache`, Supabase 자격증명만 전달 |
| Hotdrop | User Matches Sync 직후 바로 호출 | 첫 호출 전 60초 대기(`HOTDROP_START_COOLDOWN_MS`), 429 로 건너뛰면 단계 요약에 기록 |

## 근거

- 감사 실패: run 39500200074(10-20), 40779596694(10-28) 등에서 `57014 canceling statement due to statement timeout`.
- 운영 EXPLAIN(읽기 전용, 2026-10-30): `updated_at` 정렬은 단독 인덱스가 없어 `(platform, player_id, updated_at)` 인덱스 전체를 훑은 뒤 정렬한다. fullResult 경로를 offset 400부터 200행 읽으면 건너뛴 행까지 풀어 1.36초, 이전 방식은 행당 평균 약 50KB를 1,000행 전송했다. 새 방식은 키 조회 1ms 미만, 경로 조회 100키당 약 0.2초다. 새 인덱스는 만들지 않았다.
- Hotdrop 429: 10-16, 10-18, 10-22 실행.
- 로그의 일부 숫자가 `***`로 가려진 것은 숫자 secret(`CLEANUP_TARGET_VERSION`, 코드 기본값 56) 참조 때문으로 본다. 10-28 User Matches Sync 로그의 `durationMs":5***09`가 실제 실행 시간 약 56초(55609ms)와 맞는다.

## 운영자 확인 사항

- 병합 후 저장소 secret `CLEANUP_TARGET_VERSION`은 더 이상 참조되지 않으므로 삭제해도 된다.
- 자기장 데이터(`app-data/bluezone_data_v2.json`, 2026-10-28 기준 4,195건·약 2.2MB)는 하루 최대 150건씩 계속 늘고 `/api/bluezone`이 전체를 응답한다. 오래된 매치는 원본을 다시 받을 수 없어 잘라내면 복구할 수 없으므로 이번에는 구현하지 않았다. 맵별 최근 N건(예: 1,000건) 상한을 별도로 결정한다.
