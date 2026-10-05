# 과거 전적의 누락 계정 연결 복구

이 작업은 기존 20쌍의 전적 40건에 비어 있는 계정 ID만 연결한다. 분석 결과와 기본 전적은 그대로 보존한다. 계정 연결 근거와 R2 사본 정리 적격 근거를 구분한다.

기존 분석의 `fullResult.stats.playerId`를 필수로 확인한다. 저장 행과 명시적 경기 ID·플랫폼·닉네임, 실제 킬·대미지·순위·경기 시각·모드가 같아야 한다. 공식 맵 코드와 한국어 이름은 기존 `MAP_NAMES`만 사용하여 대조한다. 다른 계정 필드나 날짜 필드가 충돌하면 중단한다. 같은 경기의 다른 닉네임에 이미 해당 계정이 연결돼 있어도 제외한다.

`prepare_legacy_account_bindings.ts`는 기본 읽기 전용이다. mode 0600의 기존 제한된 private target 목록에서 최대 20쌍만 읽으며, 두 DB 응답 합계 24MiB·각 201행 미만을 제한한다. 현재 전적과 분석의 전체 행 스냅샷을 압축하고 기존 recovery key로 암호화하여 복구 journal을 생성·readback한다. SQL은 별도 private 파일로 작성하며 자동 실행하지 않는다.

운영 workflow `R2 Legacy Copy Verification`의 `prepare-account-links`는 DB와 분석·지도 원본을 수정하지 않는다. 암호화 journal을 보호된 `backups/legacy-account-bindings/`에 조건부 업로드하고 다시 읽어 바이트를 확인한다. 공개 artifact에는 집계와 암호화 journal만 포함하고 SQL과 개인 식별 값은 포함하지 않는다. 로컬 main env에는 R2 자격 증명이 없으므로 운영 백업은 workflow에서 수행한다.

적용 시 journal의 확인된 두 기록부터 SQL을 생성하여 실행한다. SQL은 전체 DB 타입 스냅샷을 재대조하고 전적·분석 행을 잠근다. 계정별 고유 인덱스가 없는 기존 전적 테이블은 짧은 table lock과 2초 lock timeout으로 동시 계정 삽입도 막는다. NULL 계정만 변경하며 계획한 수와 실제 변경 수가 다르면 한 SQL 문 전체를 취소한다. 적용 직후 계정 외 모든 값과 분석 스냅샷이 그대로인지 확인한 후 남은 대상을 진행한다. 복구 시 journal의 before를 기준으로 현재 계정·나머지 스냅샷이 적용 후 상태와 같은 경우에만 NULL로 되돌린다. 자동 rollback은 실행하지 않는다.

새 API·RPC·schema·RLS 변경은 없다. 단위 검증과 일회용 PostgreSQL의 성공·전적 변경·분석 변경·계정 충돌 시 전체 rollback 시나리오를 실행한다. CI의 migration job은 운영 자격 증명 없이 생성된 synthetic SQL fixture를 실행하며, 단위 검증에서 fixture와 실제 SQL 생성기의 일치를 확인한다.

계정 연결이 끝나도 기존 이벤트 배열에는 공식 경기 정의와 전체 공통 원본 증명이 부족하다. 기존 정리 verifier의 조건을 낮추거나 개인 배열을 전체 원본으로 승격하지 않는다. R2 정리 적격 0이면 기존 사본을 보존하며 실제 절감도 0으로 보고한다.
