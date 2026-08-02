 # 배틀그라운드 과거 전적 영구 보존 및 90일 R2 텔레메트리 보존 설계
 
 ## 1. 개요 (Overview)
 본 설계는 PUBG 공식 API의 14일 매치 데이터 보존 제한을 극복하고, BGMS 유저의 과거 전적 이력을 DB에 영구적으로 적재 및 조회할 수 있도록 개선하는 아키텍처 스펙입니다.
 동시에 원본 텔레메트리 파일(3D 동선용 `analyze.json`)은 90일 보존 후 Cloudflare R2에서 자동 정리하여 무료 스토리지 한도(DB 500MB, R2 10GB) 내에서 안전하게 무제한 확장 가능하도록 보장합니다.
 
 ## 2. 핵심 목표 (Goals)
 - **과거 전적 영구 보관**: 유저가 검색하거나 플레이한 모든 매치의 기본 스탯(K/D, 딜량, 순위, 맵, 일시)을 Supabase DB에 영구 적재.
 - **무제한 더보기 (Cursor Pagination)**: PUBG API 호출 소모 없이 자사 DB만 100% 쿼리하여 무제한 과거 전적 더보기 제공.
 - **R2 용량 최적화**: 3D 동선 텔레메트리는 gzip 94% 압축 후 90일간 보존, 90일 초과 시 자동 클린업.
 - **UI/UX 명확성**: 90일이 지난 과거 매치는 전적 통계는 영구 노출하고, 3D 리플레이 버튼 클릭 시 만료 안내 뱃지 표기.
 
 ## 3. 데이터베이스 아키텍처 (Database Schema & Storage)
 
 ### 3.1 신규 영구 매치 테이블 (`pubg_player_matches`)
 ```sql
 CREATE TABLE IF NOT EXISTS pubg_player_matches (
   player_id VARCHAR(64) NOT NULL,       -- 정규화된 소문자 닉네임 (lower_nickname)
   platform VARCHAR(16) NOT NULL,        -- steam | kakao
   match_id VARCHAR(64) NOT NULL,        -- PUBG API 매치 식별자
   played_at TIMESTAMPTZ NOT NULL,       -- 매치 생성 일시 (createdAt)
   game_mode VARCHAR(32) NOT NULL,       -- squad, duo, solo, squad-fpp 등
   map_name VARCHAR(32) NOT NULL,        -- Erangel, Miramar, Taego 등
   kills INT NOT NULL DEFAULT 0,
   damage INT NOT NULL DEFAULT 0,
   win_place INT NOT NULL DEFAULT 99,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   PRIMARY KEY (player_id, platform, match_id)
 );
 
 -- 커서 기반 무제한 페이지네이션을 위한 복합 인덱스
 CREATE INDEX IF NOT EXISTS idx_pubg_player_matches_pagination 
   ON pubg_player_matches(player_id, platform, played_at DESC);
 ```
 
 ### 3.2 계층별 저장 및 클린업 정책
 | 구분 | 데이터 종류 | 저장소 | 보존 기간 | 용량/영향 |
 | :--- | :--- | :--- | :--- | :--- |
 | **요약 전적** | K/D, 딜량, 순위, 맵, 일시 | Supabase DB (`pubg_player_matches`) | **영구 보존** | 매치당 ~150B (100만 건 = ~150MB) |
 | **전술 분석 요약** | AI 스쿼드 요약, 전술 지표 | Supabase DB (`processed_match_telemetry`) | **영구 보존** | 핵심 분석 유저 매치만 저장 |
 | **3D 동선 텔레메트리** | `analyze.json` 리플레이 파일 | Cloudflare R2 | **90일 보존 후 자동 삭제** | gzip 압축 파일당 ~400KB |
 
 ## 4. API & 페이지네이션 데이터 흐름 (Data Flow)
 
 ### 4.1 `/api/pubg/player` (초기 닉네임 검색 - Page 1)
 1. PUBG API에서 최근 14일 매치 ID 수집.
 2. DB (`pubg_player_matches`)에 수집된 매치 기본 요약 정보 `UPSERT`.
 3. DB에서 최신 매치 20개를 쿼리하고, 다음 요청용 `nextCursor` (20번째 매치의 `played_at`) 반환.
 
 ### 4.2 `/api/pubg/player/matches` (신규 - 페이지네이션 더보기 API)
 1. **클라이언트 요청**: `GET /api/pubg/player/matches?nickname=xxx&platform=steam&cursor=2026-07-20T12:34:56Z`
 2. **DB 쿼리**:
    ```sql
    SELECT * FROM pubg_player_matches
    WHERE player_id = lower(:nickname) AND platform = :platform AND played_at < :cursor
    ORDER BY played_at DESC
    LIMIT 20;
    ```
 3. **특징**: PUBG 공식 API 호출 0건. DB 커서 인덱스 쿼리로 1ms 이내 반환.
 
 ## 5. UI/UX 및 만료 안내 (User Experience)
 - **전적 리스트**: 과거 매치도 카드 형태로 통계(K/D, 딜량, 순위, 맵 등)가 동일하게 표시됨.
 - **3D 리플레이 버튼**:
   - `played_at` 이 최근 90일 이내: 정상 3D 리플레이 페이지 진입.
   - `played_at` 이 90일 경과: 마우스 호버 및 클릭 시 *"90일이 경과하여 3D 동선 데이터가 만료되었습니다"* 툴팁 및 비활성화 안내 뱃지 노출.
 
 ## 6. 테스트 및 검증 방안 (Verification)
 - **마이그레이션 검증**: `pubg_player_matches` 테이블 생성 및 인덱스 쿼리 성능 확인.
 - **페이지네이션 단위 테스트**: 100개 이상의 매치가 적재된 상태에서 커서 기반 더보기 API 속도 및 결과 검증.
 - **R2 라이프사이클 클린업 검증**: `CLEANUP_RETENTION_DAYS=90` 환경변수로 dry-run 실행하여 90일 이전 텔레메트리 파일만 정상 분류되는지 확인.
