# PUBG 총기 메타 동향 분석 및 LMG 패치 효과 검증 시스템 설계서

## 1. 개요 (Executive Summary)

### 1.1 목적
PUBG 3개월 단위 총기 리밸런싱 패치(LMG 메타 선언 등)에 맞춰, 실제 유저 및 최상위 랭커 데이터에 기반한 **전체 총기 카테고리 실시간 메타 동향 대시보드**를 제공한다.
패치 전 7~14일 기준점(Baseline)과 패치 후 데이터를 비교하여 LMG 등 리밸런싱 무기의 픽률, 유효 딜량 지분, 교전 효율성 및 지속 연사 명중 유지력 변화를 팩트로 검증한다.

### 1.2 핵심 요구사항
- **아이콘 규격**: 텍스트 이모지(🚀, 📉 등)를 일체 사용하지 않으며, Lucide-react SVG 아이콘(`<TrendingUp />`, `<TrendingDown />`, `<Target />` 등)과 시그니처 뱃지 UI로 구성.
- **과거 Baseline 데이터**: 일회성 백필 스크립트로 기존 DB 적재 텔레메트리 7~14일 치를 1회 자동 집계하여 패치 당일 비교 기준점 즉시 확보.
- **데이터 노이즈 정제**: 허공 사격/차량 사격 오염을 제외한 순수 PvP 유효 데미지 + 1.5초 갭 교전 버스트 시간창(Time Window) 기반 지속 명중 밀도(Continuous Hit Density) 계산.
- **실시간 적재**: 일반 유저 전적 검색(`source=user`) 및 GitHub Actions 벤치마커 수집(`source=scraper`) 양쪽 파이프라인에서 자동 집계.

---

## 2. 아키텍처 및 데이터 흐름 (Architecture & Data Flow)

```
[ 일반 유저 검색 (source=user) ]                                 -> [ /api/pubg/match ] -> [ AnalysisEngine ] -> [ persistMatchAnalysis ]
[ GH Actions 벤치마커 (source=scraper) ] /                                            │
                                                                                       ▼
                                                                        [ weapon_meta_snapshots (Supabase) ]
                                                                                       │
                                                                                       ▼
                                                                     [ /meta 또는 /stats 실시간 대시보드 UI ]
```

### 2.1 이중 수집 구조 (Dual Ingestion)
- **유저 검색 매치**: 유저가 웹에서 조회를 수행할 때 백엔드 파이프라인에서 적재.
- **GitHub Actions 벤치마커 매치**: 상위 500명 랭커 경기가 수집될 때 백엔드 API(`source=scraper`)를 거쳐 자동 적재되므로 유저 접속이 적은 패치 당일 새벽에도 신뢰도 높은 상위권 랭커 메타 데이터가 확보됨.

---

## 3. 데이터 정제 및 피격 시간창(Time Window) 명중률 산출 로직

### 3.1 3중 노이즈 정제 필터
1. **PvP 유효 타격 전용 필터링**: `LogPlayerTakeDamage` 이벤트 중 팀킬, 자해, 환경 데미지, 오브젝트/차량 타격을 제외하고 순수 적 플레이어 대상 타격만 카운트.
2. **최소 교전 채용(Active Pick) 조건**: 매치에서 해당 총기로 적에게 PvP 유효 데미지(`damage > 0`)를 1회 이상 입힌 유저만 실제 유효 채용으로 판별(단순 소지 후 버린 총기 제외).
3. **킬/기절 전환 효율성 (Efficiency Index)**:
   $$\text{Efficiency Index} = \frac{\text{Kills} + \text{DBNOs}}{\text{PvP Damage} / 1000}$$
   (1,000 데미지당 획득한 킬/기절 수로 허공 사격에 의한 딜량 뻥튀기를 보정)

### 3.2 교전 버스트(Engagement Burst) 시간창 명중 밀도
- **버스트 세션 정의**: 동일 타겟에 대한 피격 이벤트 간 시간 갭이 **1.5초 이하**인 연속 타격을 단일 `Continuous Combat Window`로 생성.
- **초반 버스트 밀도 (First 1.0s Density)**: 교전 시작 후 1초 이내 유효 타격 수 (AR 총기 우세 구간 측정).
- **지속 연사 명중 밀도 (Sustained Fire Density, 1.0s~3.0s)**: 1초 이상 지속 연사 시 타격 유지 비율 (LMG의 반동 제어 지속성 및 패치 성능 입증 구간).

---

## 4. 데이터베이스 설계 (Database Schema)

### 4.1 `weapon_meta_snapshots` 테이블
```sql
CREATE TABLE IF NOT EXISTS public.weapon_meta_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patch_version text NOT NULL DEFAULT 'current',
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  weapon_category text NOT NULL, -- 'AR', 'DMR', 'LMG', 'SR', 'SG', 'SMG', 'OTHERS'
  weapon_name text NOT NULL,     -- 'M249', 'Beryl M762', 'M416', 'DP-28' 등
  match_count integer NOT NULL DEFAULT 0,
  active_pick_count integer NOT NULL DEFAULT 0,
  total_kills integer NOT NULL DEFAULT 0,
  total_dbnos integer NOT NULL DEFAULT 0,
  total_damage numeric(12, 2) NOT NULL DEFAULT 0,
  first_sec_hits integer NOT NULL DEFAULT 0,
  sustained_hits integer NOT NULL DEFAULT 0,
  sustained_burst_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_weapon_meta_snapshot UNIQUE (patch_version, snapshot_date, weapon_name)
);
```

---

## 5. UI / UX 상세 명세

### 5.1 컴포넌트 구성 (`components/meta/WeaponMetaDashboard.tsx`)
1. **패치 요약 헤더**:
   - 패치 버전 정보(`31.2 Patch`), 비교 기준일(`패치 전 7일 평균 vs 패치 후`), 총 분석 표본 매치 수.
   - SVG 아이콘: `<Layers className="w-5 h-5 text-indigo-400" />`
2. **급상승 / 급하락 TOP 5 (Major Meta Movers)**:
   - 급상승 카드는 `<TrendingUp className="w-4 h-4 text-emerald-400" />` 아이콘과 그린 뱃지 사용.
   - 급하락 카드는 `<TrendingDown className="w-4 h-4 text-rose-400" />` 아이콘과 레드 뱃지 사용.
3. **카테고리 지분율 (AR / DMR / LMG / SMG / SR / SG)**:
   - 패치 전후 지분율(%) 변화 바 차트 및 지분 증감 수치 표시.
4. **전체 총기 세부 메타 1:1 비교 테이블**:
   - 필터 탭: [ 전체 | AR | DMR | LMG | SMG | SR | SG ]
   - 컬럼: 총기명, 카테고리, 픽률(변화량), K/D, 1,000딜당 킬전환율, 지속연사 타격유지력.

---

## 6. 백필 스크립트 (`scripts/backfill_weapon_meta.ts`)

- 기존 `processed_match_telemetry` 및 `match_stats_raw` 테이블에 보관된 최근 14일 치 경기를 일단위로 조회.
- 패치 시작일 이전 날짜를 `pre_patch` 버전 태그로 집계하여 `weapon_meta_snapshots`에 원자적 수집.

---

## 7. 검증 및 테스트 계획 (Verification Strategy)

1. **시간창 버스트 파싱 단위 테스트**: `tests/weapon-burst-density.test.ts` (1.5초 갭 분리 및 밀도 산출 정합성 검증)
2. **적재 파이프라인 통합 테스트**: `tests/weapon-meta-snapshot.test.ts` (match 분석 후 UPSERT 누적 검증)
3. **UI 렌더링 및 이모지 검사**: `tests/weapon-meta-ui.test.ts` (Lucide-react SVG 렌더 및 텍스트 이모지 0건 검증)
