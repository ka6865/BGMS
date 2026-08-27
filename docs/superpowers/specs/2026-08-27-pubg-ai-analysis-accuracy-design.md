# PUBG AI 전적 분석 정확도 고도화 설계 사양

- 작성일: 2026-08-27 KST
- 상태: 승인된 구현 기준(implementation-ready)
- 범위: PUBG telemetry 입력 계약, 단일 매치 분석, 최근 10경기 AI 요약, 단일 매치 AI 코칭, 익명 정확도 감사
- 기준 저장소: Next.js App Router + TypeScript + Supabase + Cloudflare R2

## 1. 결정, 목표, 비목표

### 결정

텔레메트리 정규화·허용 이벤트·lite/full 위치 샘플링을 순수 모듈 하나로 고정한다. `app/api/pubg/match/route.ts`와 `app/api/pubg/telemetry/route.ts`는 이 모듈의 결과만 `AnalysisEngine`에 전달하고, domain handler는 이미 필터된 이벤트를 다시 줄이지 않는다. 최근 AI 요약은 점수 상위 경기를 고르는 대신 최신의 유효한 고유 경기 10개를 같은 집합으로 집계하며, 단일 매치 AI는 서버 canonical 분석 row가 확인된 경우에만 생성한다.

### 목표

1. 공식 telemetry 이벤트와 필드를 한 곳에서 순수 함수로 정규화·필터링한다.
2. 다음 공식 중첩 필드·배열·scalar와 레거시 alias를 보존해 분석 누락을 없앤다.
   - `LogPlayerRedeployBRStart.characters[]`
   - `LogPlayerKillV2.assists_AccountId`, `teamKillers_AccountId`
   - `LogCarePackageSpawn`/`LogCarePackageLand.itemPackage.location`
   - `Character.location` 및 입력에 남아 있는 `loc`
   - `LogPlayerAttack`, 차량 이벤트, 보급 상자 이벤트
3. lite에서는 비팀 `LogPlayerPosition`을 한 번만 1/10로 샘플링하고, full에서는 사전 샘플링 없이 모두 보존한다.
4. 최신 유효 10경기 전체를 AI 집계, mastery, trend, 모드·맵 grouping에 동일하게 사용하고 선택 결과를 cache identity에 반영한다.
5. 단일 매치 AI 생성 시 브라우저가 보낸 수치가 아니라 `processed_match_telemetry`의 검증된 canonical `fullResult`만 prompt에 사용한다.
6. 외부 Gemini 호출 없이 legacy/new 결과를 비교하는 읽기 전용 audit을 제공하고, 자격 증명이 없으면 공식 shape synthetic fixture로 명확하게 전환한다.

### 비목표

- DB migration, 테이블 구조 변경, 기존 R2 객체 일괄 복사·삭제는 하지 않는다.
- UI, 응답 표시 컴포넌트, Gemini 모델 목록·우선순위는 변경하지 않는다.
- 현재 consumer가 없는 `LogWeaponFireCount`를 allowlist나 새 지표에 넣지 않는다.
- full 경로에서 기존 handler가 소비하던 레거시 `LogWeaponFire`, `LogExplosiveExplode`는 회귀 방지를 위해 계속 보존한다.
- 실제 사용자 raw telemetry를 Gemini 또는 다른 외부 AI 서비스로 보내지 않는다.

## 2. 공식 문서 근거

계약 fixture와 필드 이름은 아래 공식 문서를 기준으로 검증한다.

- [Telemetry Events](https://documentation.pubg.com/en/telemetry-events.html): `_T`, `_D`, `common` 및 이벤트별 schema.
- [Telemetry Objects](https://documentation.pubg.com/en/telemetry-objects.html): `Character.location`, `ItemPackage.location`, `Location` 단위(센티미터), `GameState`.
- [Telemetry](https://documentation.pubg.com/en/telemetry.html): match asset URL에서 telemetry 배열을 읽는 흐름.
- [Changelog](https://documentation.pubg.com/en/changelog/changelog.html): redeploy 이벤트, `LogPlayerKillV2` account 배열, `airoyale`·`seasonal` matchType.

정확도에 직접 영향을 주는 필드의 보존 규칙은 다음과 같다.

| 이벤트/객체 | 공식 입력 | canonical 동작 | 레거시 호환 |
| --- | --- | --- | --- |
| `LogPlayerRedeployBRStart` | `characters: Character[]` 또는 `CharacterWrapper[]` | 배열 순서와 모든 원소를 보존하고 내부 character를 정규화 | wrapper shape 유지, `character` 없는 원소도 직접 actor로 처리 |
| `LogPlayerKillV2` | `assists_AccountId`, `teamKillers_AccountId` | 문자열만 유지하고 중복 제거 | `assistantAccountIds`, `teamKillerAccountIds` alias를 동일 값으로 제공 |
| `LogCarePackageSpawn`, `LogCarePackageLand` | `itemPackage.location` | nested `itemPackage`와 location을 함께 보존 | top-level `location`을 같은 canonical 좌표로 제공 |
| `Character` | `location` | 유효한 x/y와 z(없으면 0)로 canonicalize | `location`이 없을 때만 `loc` 사용 |
| `LogPlayerUseThrowable` | top-level `weapon` | 기존 route가 보존하는 `weapon` object/scalar를 계속 전달 | weapon이 모두 사라졌다고 가정하지 않음 |

`LogWeaponFireCount`는 공식 문서에 있더라도 현재 downstream consumer가 없으므로 이번 계약에서 제외한다. 향후 consumer와 별도 버전이 승인될 때만 추가한다.

## 3. 기존 경계와 호환성

| 경계 | 현재 파일 | 변경 원칙 |
| --- | --- | --- |
| lite 상세 분석 | `app/api/pubg/match/route.ts` | raw telemetry를 shared filter에 한 번 전달하고 기존 `fullResult` JSON 필드를 유지 |
| full/lite map telemetry | `app/api/pubg/telemetry/route.ts` | query의 `mode`를 filter context로 사용; `full`은 모두 보존 |
| 분석 consumer | `lib/pubg-analysis/AnalysisEngine.ts`, `handlers/*.ts` | 입력 event를 재필터링하지 않고 official-first fallback으로 읽음 |
| 최근 요약 | `app/api/pubg/ai-summary/route.ts` | 기존 NDJSON `visuals`/`final`/`done` 모양 유지; 선택 집합과 cache hash만 의미 변경 |
| 단일 코칭 | `app/api/pubg/ai-analyze/route.ts` | cache hit NDJSON 유지; canonical 부재·stale만 명시적 409 추가 |

기존 API response field, telemetry envelope/payload field, AI cache table field와 기존 cache-hit stream은 유지한다. 의도적인 identity 변경은 recent selection config/version을 포함하는 summary hash와 `AI_CACHE_VERSION`이며, 의도적인 오류 변경은 canonical 분석을 사용할 수 없을 때의 409이다. migration, UI/model 변경은 없다.

## 4. 공용 telemetry contract/filter

### 4.1 순수 모듈과 인터페이스

새 `lib/pubg-analysis/telemetryContract.ts`는 route, `server-only`, Supabase, R2, crypto, 전역 시계를 import하지 않는다. 입력을 mutate하지 않고 같은 입력·context에 같은 배열을 반환한다.

```ts
export type TelemetryFilterMode = "lite" | "full";

export type TelemetryFilterContext = {
  mode: TelemetryFilterMode;
  teamNames: ReadonlySet<string>;      // normalizeName 결과
  teamAccountIds: ReadonlySet<string>;
};

export type TelemetryEventRecord = Record<string, unknown>;

/** 공식 이벤트의 canonical 순서. filter 결과도 원본 입력 순서를 유지한다. */
export const TELEMETRY_EVENT_ALLOWLIST: readonly string[];

export function normalizeTelemetryLocation(
  value: unknown,
): { x: number; y: number; z: number } | undefined;

export function projectTelemetryEvent(
  event: unknown,
): TelemetryEventRecord | null;

export function filterTelemetryEvents(
  events: readonly unknown[],
  context: TelemetryFilterContext,
): TelemetryEventRecord[];
```

`TELEMETRY_EVENT_ALLOWLIST`는 아래에 적힌 고정 순서의 readonly 배열이다. membership lookup이 필요하면 함수 내부에서만 Set을 파생하며, 반환 event는 입력 배열 순서를 절대 sort하지 않는다. `_T`가 없거나 allowlist에 없는 event는 버린다.

### 4.2 공식 allowlist

```text
LogMatchStart
LogMatchEnd
LogGameStatePeriodic
LogPhaseStart
LogPhaseChange
LogPlayerCreate
LogPlayerPosition
LogParachuteLanding
LogPlayerAttack
LogPlayerTakeDamage
LogPlayerMakeGroggy
LogPlayerMakeDBNO
LogPlayerKill
LogPlayerKillV2
LogPlayerRevive
LogPlayerRecall
LogPlayerRecallShip
LogPlayerRedeploy
LogPlayerRedeployBRStart
LogPlayerUseThrowable
LogWeaponFire
LogPlayerUseHeal
LogThrowableUse
LogProjectileHit
LogItemUse
LogHeal
LogVehicleRide
LogVehicleLeave
LogCarePackageSpawn
LogCarePackageLand
LogExplosiveExplode
```

`LogWeaponFireCount`와 임의의 미래 event는 이 목록에 없다. 허용 event를 추가하는 경우 같은 변경에서 downstream consumer와 field fixture를 갱신한다.

### 4.3 projection과 보존 필드

`projectTelemetryEvent`는 새 object를 만들고 다음 규칙을 적용한다.

- `_T`, `_D`와 존재하는 `common.isGame` 또는 `Common.IsGame`을 보존한다.
- actor key(`attacker`, `victim`, `killer`, `finisher`, `dBNOMaker`, `maker`, `reviver`, `recaller`, `character`, `recallingPlayer`, `recalledPlayer`, `assistant`)는 `name`, `characterName`, `accountId`, `playerId`, `teamId`, `location`, `health`, `isInVehicle`, `vehicle`, `rotation`, `viewDir`, `weaponId`, `heldItems`를 값이 있을 때 보존한다.
- actor 위치는 `location`을 먼저 읽고 없을 때 `loc`를 읽는다. x와 y가 유한한 숫자일 때만 canonical `location`을 만들며 z가 없을 때만 0을 사용한다. actor에 좌표가 없으면 `{0,0}`을 새로 만들지 않는다.
- item key(`item`, `weapon`, `damageCauser`)는 `itemId`, `name`, `stackCount`, `category`, `subCategory`, `attachedItems`를 보존한다. `LogPlayerUseThrowable.weapon`도 이 규칙으로 보존한다.
- vehicle key는 `vehicleId`, `vehicleType`, `vehicleUniqueId`, `healthPercent`, `velocity`, `seatIndex`, `isWheelsInAir`, `isInWaterVolume`, `isEngineOn`을 보존한다.
- 공식 scalar(`attackId`, `fireWeaponStackCount`, `attackType`, `dBNOId`, `damage`, `damageReason`, `damageTypeCategory`, `damageCauserName`, `distance`, `phase`, `elapsedTime`, `isThroughPenetrableWall`, `isAttackerInVehicle`, `isSuicide`, `reviveType`, `weaponId`, `victimWeapon`, `victimWeaponAdditionalInfo`, `killerDamageInfo`, `finishDamageInfo`, `dBNODamageInfo`)는 `undefined`가 아니면 보존한다.
- `characters`는 downstream이 실제 소비하는 `LogPlayerRedeployBRStart`와 기존에 보존하던 `LogMatchEnd`에서만 복사한다. wrapper 원소는 wrapper의 다른 scalar를 유지하면서 내부 `.character`를 actor projector로 만들고, 직접 Character 원소도 같은 actor projector를 사용한다. `LogMatchStart.characters` 전체를 lite R2 payload에 새로 넣어 저장량을 늘리지 않는다.
- `recalledPlayers`도 각 원소를 actor/wrapper 형태 그대로 정규화한다.
- `assists_AccountId`와 `teamKillers_AccountId`는 문자열 배열을 순서대로 dedupe해 보존한다. 같은 배열을 각각 `assistantAccountIds`와 `teamKillerAccountIds`로 제공한다. 입력에 공식 배열이 없을 때만 기존 alias를 fallback으로 읽는다.
- `itemPackage`는 consumer가 쓰는 `itemPackageId`, `location`만 보존한다. 전체 `items` 배열은 저장하지 않는다. `itemPackage.location`이 유효하면 top-level canonical `location` alias를 만들되 handler는 공식 nested 값인 `itemPackage.location`을 먼저 선택한다.

### 4.4 위치 샘플링 소유권

- `mode: "full"`: `LogPlayerPosition`을 하나도 사전 제거하지 않는다.
- `mode: "lite"`: team actor 위치는 전부 보존한다. 비팀 actor 위치는 입력 순서대로 1부터 세고 10, 20, 30번째만 보존한다. 호출마다 counter는 local이다.
- team 판정은 actor `accountId` 또는 `playerId`가 `teamAccountIds`에 있거나 `normalizeName(actor.name)`이 `teamNames`에 있을 때 true다. 식별되지 않는 actor는 비팀으로 취급한다.
- `MapReplayHandler`에는 위치 modulo/counter가 없어야 한다. contract가 보존한 위치를 모두 map event로 변환하며, filter와 handler가 각각 1/10을 적용하지 않는다.

## 5. 두 route와 handler 적용

`match/route.ts`는 participant/roster에서 이미 만든 team set으로 `filterTelemetryEvents(rawTelemetry, { mode: "lite", teamNames, teamAccountIds })`를 한 번 호출한다. 기존 R2 analyze payload, engine 입력, processed row는 반환 배열을 공유한다. route-local allowlist와 actor slim-map은 제거한다.

`telemetry/route.ts`는 요청의 `mode`를 그대로 context에 넣는다. route가 이미 읽은 `myInfo`, roster, participants에서 내 roster를 찾고 `teamNames`/`teamAccountIds`를 만든 뒤 filter context에 전달한다. full 요청은 모든 위치를 포함하고 lite 요청은 shared contract 규칙을 따른다. 두 route 모두 `AnalysisEngine.run` 이전에 같은 projection 결과만 사용한다.

handler의 official-first fallback은 다음 우선순위를 고정한다.

1. `CombatHandler.handleRecall`: `characters[]`의 각 원소(`wrapper.character ?? wrapper`)를 먼저 순회하고, 그 다음 `recalledPlayers`, `victim`, `character`, `recallingPlayer`, `recalledPlayer`를 기존 fallback으로 본다. `LogPlayerRedeployBRStart`도 이 경로에서 team timeline/state를 복구한다.
2. kill/assist consumer: `assists_AccountId ?? assistantAccountIds`, `teamKillers_AccountId ?? teamKillerAccountIds` 순으로 읽고 dedupe 결과를 사용한다.
3. `MapReplayHandler` 보급 상자: `itemPackage.location ?? event.location` 순으로 좌표를 읽는다. 위치가 없으면 좌표 event를 만들지 않는다.
4. `PositionHandler`, `ZoneHandler`, `MapReplayHandler`, `CombatHandler`의 actor 위치: `character.location ?? character.loc` 및 동일한 actor fallback 순서를 사용한다.
5. `MapReplayHandler.handlePosition`은 입력 수만큼 event를 만들고 적 위치를 다시 샘플링하지 않는다.

기존 `mapData.events`, `mapData.zoneEvents`, `timeline`, `teammates`, `teamNames`의 JSON field 이름과 scale 단위는 유지한다. top-level throwable `weapon` 역시 현재 route 보존 동작을 유지한다.

## 6. 최신 유효 10경기 선택

새 순수 모듈 `lib/pubg-analysis/recentMatchSelection.ts`가 summary의 입력 집합과 선택 사유를 소유한다.

```ts
export const RECENT_MATCH_SELECTION_VERSION = "recent-valid-10-v1";

export type RecentMatchCandidate<T = unknown> = {
  id: string | null;
  createdAt: string | null;
  matchType: string | null;
  gameMode: string | null;
  mapName: string | null;
  sourceIndex: number;
  value: T;
};

export type SelectionRejectionReason =
  | "missing_id"
  | "match_type_excluded"
  | "mode_excluded"
  | "map_excluded"
  | "duplicate_id"
  | "over_limit";

export type RecentMatchSelection<T = unknown> = {
  selected: RecentMatchCandidate<T>[];
  rejected: Array<{
    candidate: RecentMatchCandidate<T>;
    reason: SelectionRejectionReason;
  }>;
  selectionVersion: string;
};

export function normalizeMatchId(rawId: unknown): string | null;
export function selectRecentMatches<T>(
  candidates: readonly RecentMatchCandidate<T>[],
  options?: { limit?: number; selectionVersion?: string },
): RecentMatchSelection<T>;
export function buildMatchSelectionKey(
  ids: readonly string[],
  selectionVersion?: string,
): string;
```

선택 규칙은 다음과 같다.

1. `normalizeMatchId`는 `shard:match-id`의 마지막 segment를 반환하고 빈 값은 null이다. route는 `matchId`, `match_id`, `id`의 우선순위로 candidate를 만든다.
2. canonical ID가 같은 후보는 하나만 남긴다. duplicate winner는 parse 가능한 `createdAt`이 더 최신인 것, 그 다음 작은 `sourceIndex`, 그 다음 lexical canonical ID 순으로 안정 결정한다.
3. `matchType`은 case-insensitive `airoyale` 또는 `seasonal`만 제외한다. `official`, `competitive`, `unknown`, 빈 값과 저장된 미지 값은 허용한다.
4. `gameMode`에 `event`, `arcade`, `custom`, `training`이 포함되면 제외한다.
5. `mapName`에 `safehouse`, `range`, `training`이 포함되면 제외한다. `_Main` suffix와 대소문자는 구분하지 않는다.
6. 유효 후보는 parse 가능한 `createdAt` 내림차순으로 정렬하고, invalid/missing date는 뒤로 보낸다. 날짜 동률은 `sourceIndex` 오름차순, canonical ID 오름차순으로 정한다.
7. 기본 limit은 10이다. score, winPlace, impactScore로 재정렬하거나 Best 5를 고르지 않는다.
8. `selection.selected`만 summary `aggregateMatches`, mode grouping, map grouping, benchmark prompt, mastery, trend에 전달한다. AI용 통계와 UI mastery 통계를 다른 집합으로 계산하지 않는다.
9. `buildMatchSelectionKey`는 selection version과 선택된 canonical ID의 dedupe·lexical sort 결과를 newline으로 직렬화한다. route는 processed rows와 필요한 missing match를 모아 selector를 실행한 뒤에 cache lookup을 수행하고, `SHA-256(AI_CACHE_VERSION + "\n" + selectionKey)`를 `player_ai_summary_cache.match_ids_hash`에 사용한다. 탈락 ID와 선택되지 않은 row는 hash에 넣지 않는다. `force=true`는 이 lookup만 건너뛰고 기존처럼 새 결과를 생성한다.

## 7. 단일 매치 AI canonical 경계

대상은 `POST /api/pubg/ai-analyze`다.

### 7.1 요청, schema, cache hit

- `matchData`에서 신뢰하는 값은 `matchId`/`match_id`/`id` 중 canonical match identity뿐이다. stats, benchmark, timeline, mapData, text는 새 생성에 사용하지 않는다.
- `nickname`은 `normalizeName`으로 player identity를 만들고, `platform`은 기존 `normalizePlatform`을 사용한다.
- `coachingStyle`은 `"mild" | "spicy"`만 허용한다. 누락은 기존 기본값 `spicy`를 유지하고 다른 값은 400 `PUBG_AI_INVALID_COACHING_STYLE`로 거절한다.
- 현재 identity(`match_id`, normalized `player_id`, normalized `platform`, `coaching_style`, `AI_CACHE_VERSION`)를 먼저 조회한다. hit이면 현재 NDJSON chunk/done와 language sanitization을 그대로 반환하고 canonical row 조회·Gemini 호출을 추가하지 않는다.

### 7.2 canonical lookup

`lib/pubg-analysis/cacheIdentity.ts`에 다음 pure validator를 추가한다.

```ts
export type CanonicalMatchLookup = {
  matchId: string;
  playerId: string;
  platform: string;
  minResultVersion: number;
};

export function getValidFullResultForMatch(
  row: unknown,
  expected: CanonicalMatchLookup,
): Record<string, unknown> | null;
```

validator는 `row.data.fullResult`가 record인지 확인하고, 기존 player/name/platform 검증을 통과하며, `row.match_id` 또는 `fullResult.matchId`의 canonical ID가 expected match ID와 같은지 확인한다. `fullResult.v`가 `minResultVersion`보다 낮거나 없으면 stale로 null을 반환한다. row의 player/platform이 존재하면 expected와도 일치해야 하며, malformed row·다른 account/name·다른 platform은 null이다.

cache miss 뒤 route는 service-role `processed_match_telemetry`에서 expected match/player/platform을 조건으로 `match_id, player_id, platform, data`만 읽고 validator를 적용한다. null이면 Gemini와 AI cache upsert를 실행하지 않고 아래를 반환한다.

```json
{
  "error": "canonical match analysis is not ready",
  "errorCode": "PUBG_AI_CANONICAL_NOT_READY",
  "retryable": true
}
```

HTTP status는 409다. match identity 형식 오류는 400으로 fail-closed할 수 있지만 raw row, accountId, nickname 원문은 body나 로그에 넣지 않는다. validator를 통과한 canonical fullResult만 `buildMatchAiCoachingPrompt({ matchData: canonicalFullResult, coachingStyle })`에 전달하며, 이후 기존 sanitization, usage tracking, stream, cache upsert 형식은 유지한다.

## 8. 버전과 cache invalidation

의미가 바뀐 결과가 구 cache에 가려지지 않도록 Task 5 한 커밋에서만 아래 세 export를 각각 한 번 갱신한다.

```ts
export const RESULT_VERSION = 73.0;
export const TELEMETRY_VERSION = 61.0;
export const AI_CACHE_VERSION = "2026-08-27.pubg-ai-accuracy-v1";
```

- `RESULT_VERSION 73.0`: shared projection을 사용한 processed analysis result 버전.
- `TELEMETRY_VERSION 61.0`: 새 R2 analyze/map payload key 입력 계약 버전. 이전 객체를 복사하거나 삭제하지 않는다.
- `AI_CACHE_VERSION`: single, summary, squad AI prompt/cache identity를 무효화한다. 모델과 응답 schema는 바꾸지 않는다.
- Task 1~4는 값을 변경하지 않는다. 최종 diff에서 각 대입은 정확히 한 번만 나타난다.

## 9. 읽기 전용 before/after accuracy audit

새 `scripts/audit_pubg_ai_accuracy.ts`는 Gemini import/call이 없고, legacy filter/selection과 new contract/selector를 같은 입력에 적용해 차이를 집계한다.

### 9.1 실행과 입력

- `--nickname`, `--platform steam|kakao`, `--limit 1..25`, 선택적 `--output`을 받는다. 한 실행은 한 normalized user만 대상으로 한다.
- `PUBG_API_KEY`, Supabase URL/service-role key, audit nickname이 모두 이미 존재할 때만 official match GET와 asset telemetry GET를 수행한다. match 목록과 최근 분석 입력은 기존 실데이터 감사와 같은 `processed_match_telemetry` read-only select에서 읽는다.
- PUBG match GET에만 API Authorization을 보내고, 공식 문서대로 asset telemetry URL GET에는 API key를 보내지 않는다.
- 모든 외부 동작은 select/GET뿐이다. `insert`, `upsert`, `update`, `delete`, R2 upload, signed URL 생성, PUBG POST, Gemini 전송은 하지 않는다.
- 환경·권한·raw telemetry가 하나라도 없으면 고정 사유를 기록하고 `tests/fixtures/pubg-official-shaped-telemetry.json` 기반 synthetic official-shaped 입력으로 한 번 실행한다. real source 일부가 실패해도 원문이나 stack trace를 출력하지 않는다.

### 9.2 report interface와 redaction

```ts
export type AccuracyAuditReport = {
  schemaVersion: "1";
  source: "real_read_only" | "synthetic_fixture";
  fallbackReason: string | null;
  playerFingerprint: string; // SHA-256 prefix 16자
  loadedMatchCount: number;
  singleMatchMetrics: {
    legacy: Record<string, number>;
    next: Record<string, number>;
    delta: Record<string, number>;
  };
  recentSelection: {
    legacyCount: number;
    nextCount: number;
    legacyMatchFingerprints: string[];
    nextMatchFingerprints: string[];
    legacyExcluded: Record<string, number>;
    nextExcluded: Record<string, number>;
  };
  telemetry: {
    legacy: Record<string, number>;
    next: Record<string, number>;
    delta: Record<string, number>;
  };
  remoteWritesAttempted: 0;
  externalAiCalls: 0;
};

export function runAccuracyAudit(
  options?: AccuracyAuditOptions,
): Promise<AccuracyAuditReport>;
```

`singleMatchMetrics`는 event count, position sample count, team/enemy position count, redeploy character count, official assist/team-killer array count, care-package location count, attack/vehicle event count, top-level throwable weapon presence와 `AnalysisEngine` 결과의 숫자 지표(`processedDamageDealt`, `initiativeSampleCount`, duel wins/losses)를 포함한다. `telemetry`에는 event type별 count와 canonical field presence count를 넣는다. `recentSelection`에는 legacy의 유효 후보/Best 5 결과와 new의 유효 unique 10 결과를 count와 fingerprint로만 남긴다.

직렬화 전에 다음 redaction을 검사한다.

- player, match, account, URL, nickname은 SHA-256 앞 16자리 fingerprint 또는 count로만 출력한다.
- raw event object, API response, R2 path, signed URL, stack trace, 이름과 평문 match ID는 report에 없다.
- `remoteWritesAttempted`와 `externalAiCalls`는 항상 0이며 위반 시 로컬 report 파일도 쓰지 않고 exit code 1로 끝난다. 사용자가 지정한 로컬 `--output` 저장은 remote write에 포함하지 않는다.
- real source가 불가능한 경우 `source: "synthetic_fixture"`와 고정 `fallbackReason`을 함께 출력한다.

fixture는 redeploy `characters[]`, V2 official account 배열, nested `itemPackage.location`, `Character.loc` fallback, attack/vehicle/care-package event, top-level throwable `weapon`, 20 enemy position을 포함한다. fixture의 식별자는 report에서 fingerprint로만 보인다.

실행 예:

```bash
npm run audit:pubg-ai-accuracy -- \
  --nickname "$PUBG_AUDIT_NICKNAME" \
  --platform steam \
  --limit 25 \
  --output tmp/pubg-ai-accuracy-audit.json
```

## 10. TDD, 검증, 완료 기준

- 각 Task는 RED 테스트 작성 → 실패 확인 → 최소 구현 → GREEN 확인 → 독립 commit 순서다.
- 변경 전 `npm run verify:analysis` baseline은 17 files / 210 tests pass다. 새 contract/route/selection/audit 테스트를 `verify:analysis` 목록에 추가하므로 최종 파일·테스트 수는 증가하며, 기존 210개와 신규 테스트가 모두 통과해야 한다.
- 전체 완료 검증은 `npm run verify:core`, `npm run verify:analysis`, `npm run verify:admin`, 전체 Vitest/Jest, 관련 route/engine 테스트, synthetic audit, 가능할 때 한 user real read-only audit, `git diff --check` 순서로 수행한다.
- API response/cache 형식은 위에서 명시한 intentional identity/error를 제외하고 보존한다.
- DB migration, UI/model 변경, `LogWeaponFireCount` consumer, raw identity 출력이 diff에 없어야 한다.

완료 시 다음 사실을 테스트로 증명한다.

1. 두 route가 shared contract를 한 번 호출하고, lite 적 20개는 2개, full 20개는 20개이며 handler가 재샘플링하지 않는다.
2. official nested/array/scalar와 legacy fallback이 map/timeline/engine consumer까지 전달된다.
3. 최신 valid unique 10개 전체가 aggregate/mastery/trend에 쓰이고, 선택 version과 effective IDs가 summary hash에 포함된다.
4. 단일 AI cache miss는 canonical current row 없이는 409/no-Gemini/no-upsert이고, cache hit은 기존 NDJSON을 유지한다.
5. 세 버전 export가 `73.0`, `61.0`, `2026-08-27.pubg-ai-accuracy-v1`로 한 번씩만 바뀐다.
6. audit은 legacy/new single metrics와 recent selection을 비교하면서 raw identity 없이 집계와 fingerprint만 남긴다.
