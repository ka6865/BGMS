# 전적 자동 수집 실행 간격 개선

GitHub 수집은 실행 후 약 5~6분에 성공했지만, 2026-10-05 00:10~05:55 UTC 사이 예약 실행 간격이 5시간 45분이었다. 20분 cron 설정만으로 전적 보존에 필요한 실행 간격을 보장하지 못했다. GitHub 공식 문서는 예약 지연과 누락 가능성을 안내한다.

기존 큐와 수집기를 유지하면서 Supabase `pg_cron`/`pg_net`이 5분마다 운영의 `POST /api/internal/pubg/collect`를 호출한다. 한 호출은 최대 100작업/30초이며 DB·PUBG 요청도 각각 8초, 전체 38초 안에 중단한다. 기존 계정 검증, 최근/과거 작업 배분, 404 재확인, 429 재시도, 점유 토큰을 유지한다. GitHub 수집은 보조 처리와 수동 대량 처리에 사용한다. 게임 자료의 저장 방식은 바꾸지 않는다.

전용 무작위 `PUBG_MATCH_COLLECTION_SECRET`을 운영 환경에만 설정한다. 같은 값은 Vault에 보관하며 예약 SQL과 공개 로그에 직접 넣지 않는다. 서비스 역할만 설정·상태 RPC를 호출할 수 있다. URL은 `https://bgms.kr`로 제한한다. 대기가 없으면 운영 API를 호출하지 않는다. 자체 요청 ID/시각과 이 작업의 cron 로그 중 7일이 지난 기록은 정리한다. 수집 중에는 매 호출에서, 중지 후에도 별도 일일 작업에서 정리한다. pg_net 응답이 만료되어 없는 오래된 건은 실패·미완료로 단정하지 않고 확인 불가로 표시한다.

적용 순서:

1. 마이그레이션 `20261005081214_pubg_collection_database_clock`을 격리 DB에서 검사한 뒤 운영에 적용한다. 설치만으로 예약이 켜지지 않는다. MCP 적용 기록의 실제 버전과 파일명을 맞췄다.
2. 전용 비밀값을 Vercel production에 설정하고 코드를 PR/CI를 거쳐 배포한다.
3. 운영 API의 인증 거부와 인증된 제한 수집 응답을 확인한다.
4. 별도 보안 env 파일을 지정해 `BGMS_ENV_FILE=/path/to/main/.env.local BGMS_COLLECTION_ENV_FILE=/private/collection.env npx tsx scripts/configure_pubg_collection_cron.ts --apply`로 활성화한다.
5. 기본 CLI 실행으로 실제 HTTP 응답·시각을 확인한다. 수동 성공과 구분하여 5분 간격 자동 호출이 세 번 연속 200으로 완료되고 큐가 줄어드는 것을 확인한다.

중지는 같은 CLI의 `--disable`이다. 중지해도 경기와 대기 목록은 보존되며 GitHub 보조 수집을 사용할 수 있다. 비밀값을 교체하면 Vercel 배포와 Vault를 같은 새 값으로 맞춰야 한다.

로컬 PostgreSQL 검증은 Cron/Net/Vault의 테스트 인터페이스를 사용한다. 실제 확장 설치·암호화·네트워크 배달은 운영 확인으로 검증하며, 로컬 테스트를 이 검증의 대체로 보고하지 않는다.

최대 처리 기회는 하루 28,800작업이다. 실제 처리량은 응답 속도·저장 여부·404 재시도에 따라 달라진다. 자동 실행을 정상화하는 것과 기존 누적 전체가 해소되는 것은 별도 결과다. 특히 공식 API에서 이미 만료된 경기를 이 수정으로 복구했다고 보고하지 않는다.

근거: [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Supabase 예약 호출과 Vault](https://supabase.com/docs/guides/functions/schedule-functions).
