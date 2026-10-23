# LoL 증강 순수 추출·툴팁 계약

설계 근거: [아수라장 콘텐츠 설계 6·11·14절](../plans/2026-10-23-aram-mayhem-content-design.md).
이 문서는 순수 추출·표시 규칙과 2번 PR의 저장·게시 계약을 설명한다. 순수 추출 모듈은 네트워크·DB·Next 없이 실행한다.

## 모듈

- `lib/lol/augments/patchMap.ts`: `toDisplayPatch`, `toClientPatch`, `validatePatchMapping`.
  클라이언트 연도 15/16만 공개 연도 25/26으로 대응한다. Data Dragon 버전 존재 검증은 대응 관계의 교차 확인이며 패치 노트 발행일 검증은 별도 수집 단계에서 한다.
- `stringTable.ts`: `parseStringTable`, `lookupString`, `stringTableHash`, `xxh3_64`.
  평문 소문자 키를 먼저 찾고, 없으면 seed 0 xxh3_64의 하위 38비트 해시 키를 찾는다. 빈 문자열과 누락(`null`)을 구분한다.
- `extract.ts`: `extractAugmentPool`은 KIWI 목록과 cherry의 숫자 ID·내부 식별자를 연결한다.
  `extractAugments`는 kiwi.bin과 ko/en 문자열을 추가로 읽는다. 중복·누락·ID 충돌과 잘못된 입력 타입은 예외다.
  `rarityEvidence`는 cherry와 bin 등급을 함께 보존한다. bin의 생략/0은 silver, 1은 gold, 2는 prismatic이다.
  `Enabled` 생략은 true, `IsAbilityAugment` 생략은 false다. `QuestData` 존재 여부는 quest로 기록하며 비트마스크 의미는 추정하지 않는다.
  아이콘은 소문자 상대 `assets/...png` 경로이며 `.tex`를 `.png`로 바꾼다. 외부 URL과 상위 경로는 거부한다.
- `tooltip.ts`: `renderTooltip`은 안전한 `{text, style[]}` 배열과 평문, `status`, 미치환 목록·횟수, 미지원 계산 종류를 반환한다. HTML은 반환하지 않는다.
- `diff.ts`: `diffAugments`는 platformId로 추가·삭제와 이름·설명/툴팁·수치·등급·enabled 변경을 비교한다. 내부 증강은 `internal` 버킷으로 분리한다.
  부분 입력인 `AugmentPoolEntry`끼리 비교할 때는 구성·등급만 비교된다. 문자열이나 수치가 없다는 것을 값이 같다는 근거로 사용하면 안 된다.
- `validate.ts`: `validateAugments`는 일반 활성 풀의 직전 대비 ±30% 초과, 일반 활성 풀 ko/en 이름 누락 3개 초과, 전체 풀 등급 불일치와 desc 누락을 차단한다.
  `chooseAugmentDisplay`가 tooltip → desc → desc_partial 표시를 결정한다. 직전 추출본이 없으면 풀 변동 검증은 생략한다.

## 툴팁 수치 정책

- `@Var@`, `@Var*100@`, `@Var*-1@`, `@Var:Calc@`를 지원한다. 식을 실행하거나 `eval`하지 않는다.
- DataValues 배열은 0을 포함한 첫 유효값을 쓴다. 원본에 values가 없으면 빈 배열로 보존하고 치환 시 미확정으로 남긴다.
- 지원 계산: `GameCalculation`, `NumberCalculationPart`, `NamedDataValueCalculationPart`, `ByCharLevelInterpolationCalculationPart`, `SumOfSubPartsCalculationPart`, `ProductOfSubPartsCalculationPart`, `GameCalculationModified`.
- 레벨 보간은 최소~최대 범위로 표시한다. 합·곱과 음수 배수도 범위로 계산한다. `mDisplayAsPercent`는 명시 배수가 없을 때 100을 곱하고 `%`를 붙인다. 표시 수치는 소수점 4자리로 반올림한다.
- `{{문자열키}}`는 8단계까지 확장한다. 순환 참조, 누락, 미지원 계산과 런타임 토큰은 원래 토큰을 남긴다. 계산 참조·중첩도 16단계로 제한한다.
- 허용한 태그만 고정된 스타일 이름으로 바꾼다. `font`의 6자리 HEX 색은 공통 highlight 스타일로 바꾸며 속성·URL은 보존하지 않는다. 스크립트·스타일 블록은 내용까지 제거한다.
- 토큰 비율은 중첩 참조와 변수의 **출현 횟수**를 분모로 하고 미해결 출현 횟수를 분자로 한다. `unresolvedTokens` 목록은 중복을 제거하지만 횟수는 제거하지 않는다.
- `status`: 빈 결과는 failed, 미치환이 없으면 ok, 일부 토큰만 해결되면 partial, 전부 미해결이면 failed다. partial/failed는 렌더링한 desc 또는 미치환 토큰을 교체한 desc_partial로 대체할 대상이다.

## 원본 확인 명령

로컬에 확보한 CommunityDragon JSON만 읽는다. 원본 전체를 단위 테스트나 저장소에 넣지 않는다.
경로는 실제 원본 폴더로 지정한다.

```sh
source_dir='/path/to/cdragon'
node --import tsx scripts/lol_augments_extract_check.ts \
  --augment-lists "$source_dir/16.21_default_augment-lists.json" \
  --cherry-augments "$source_dir/16.21_default_cherry-augments.json" \
  --kiwi-bin "$source_dir/latest_kiwi.bin.json" \
  --stringtable-ko "$source_dir/latest_ko_kr_lol.stringtable.json" \
  --stringtable-en "$source_dir/latest_en_us_lol.stringtable.json" \
  --previous-lists "$source_dir/16.20_default_augment-lists.json" \
  --previous-cherry "$source_dir/16.20_default_cherry-augments.json"
```

종료 코드는 검증 통과 0, 파싱·경로·추출 실패 1, 추출 성공 후 게시 차단 2다.
JSON 요약에 풀 수, 내부/비활성 수, 패치 구성 diff, ko/en 토큰 비율, 항목별 실패 목록, 미지원 계산 종류와 차단 사유가 나온다.
이전 목록·cherry만으로는 이전 enabled·문자열·수치를 복원할 수 없다. 위 명령의 이전 패치 비교는 구성·등급에 한정되며 직전 일반 활성 풀 ±30% 검증도 하지 않는다.
수치·상태 변경과 풀 변동을 검증하려면 버전을 고정한 양쪽 전체 원본을 `extractAugments`로 추출하고 `diffAugments`·`validateAugments`에 전달한다.
`latest` 파일은 해당 수집 시점의 스냅샷일 뿐, 임의 시점에도 16.21이라는 보장은 없다.

## 2026-10-23 로컬 확인

- 16.21 KIWI 249개, 일반 활성 235개, GoH 내부 5개, Enabled:false 9개.
- 16.20 풀 223개 → 16.21 풀 249개. 일반 신규 35개, 내부 신규 5개, 삭제 14개(공지 13개 + id 2089). 신규 한국어 이름·등급 35개 일치.
- ko/en 각각 793개 토큰 중 338개 미치환(42.62%), 각 164개 항목이 partial/failed다. 1번 PR의 5% 기준에서는 차단됐으나, 2번 PR은 증강별 표시 규칙으로 대체한다.
- 확인된 미지원 계산: `StatByCoefficientCalculationPart`, `StatByNamedDataValueCalculationPart`, `AbilityResourceByCoefficientCalculationPart`, `BuffCounterByCoefficientCalculationPart`, `BuffCounterByNamedDataValueCalculationPart`, `ByCharLevelBreakpointsCalculationPart`, `{e9a3c91d}`, `{ee18a47b}`.
- `f1/f2`, `SpellName` 등 엔진 런타임 토큰, RootSpell 밖의 값, 해시 이름 계산과 일부 계산 형식은 추가 해석이 필요하다. 미확정 값을 0으로 바꾸지 않았다.
- `tests/fixtures/lol-augments/`는 실제 목록·cherry의 필요한 필드, 대표 kiwi.bin·문자열, 패치 노트 35개 이름을 발췌한 자료다. JSON에 긴 문자열이 있는 대표 fixture는 문자열 연결을 사용하는 TypeScript 데이터로 저장해 한 줄 300자 제한을 지킨다.
- xxh3_64는 로컬 기준 라이브러리의 UTF-8 및 길이 경계 벡터 539개와 일치했다. 런타임·테스트 의존성은 추가하지 않았다.
- `npm run verify:core` 통과(기존 ESLint 경고 47개, 추가 파일 경고 없음), `npm run verify:lol` 292개 통과·41개 조건부 제외. 추가 테스트는 25개다.
- fixture 합계는 195,005바이트이며 전체 파일의 한 줄 길이는 300자 이하다. 이 작업 폴더에는 `.agents/rules/project_rules.md`가 없어 AGENTS.md·현재 구현·package.json·테스트를 기준으로 작업했다.

## 저장 계약 (2번 PR)

`20261024010000_lol_augment_catalog.sql`은 10개 테이블과 service_role 전용 RPC 7개를 만든다.
기존 LoL 전적 테이블과는 연결하지 않는다. 이름은 키가 아니며 `platform_id`와 `client_patch`로 스냅샷을 구분한다.
기본 키의 모드는 `KIWI`만, 언어는 `ko_kr`·`en_us`만 허용한다. 패치 매핑은 추출기와 같은 15/16 → 25/26 범위다.

- 테이블: `lol_game_patches`, `lol_augments`, `lol_augment_patch_states`, `lol_augment_localizations`, `lol_augment_aliases`,
  `lol_augment_patch_changes`, `lol_augment_patch_notes`, `lol_augment_data_sources`, `lol_augment_ingestion_runs`, `lol_augment_publication`.
- 모든 테이블은 RLS를 켜고 PUBLIC·anon·authenticated 권한을 회수한다.
  RPC는 `security invoker`, `search_path=''`이며 기본 PUBLIC EXECUTE를 회수한다.
- `lol_augment_patch_states`는 패치별 등급·아이콘·내부 여부도 보존한다. 새 패치의 등급이 바뀌어도 과거 도감은 그대로다.
  전역 출현 상태는 `official_active`, `official_disabled`, `official_removed`, `official_reenabled`, `unlock_required`, `client_absent_unannounced`, `insufficient_data`만 허용한다.
  챔피언별 상태·제보·외부 주장 테이블은 다음 단계에서 만든다.

수집 호출 순서는 다음과 같다. 서버 래퍼는 `lib/lol/augments/persistence.server.ts`다.
모든 요청에 10초 타임아웃을 적용하고, 실패 로그에는 RPC명과 `timeout`·`invalid_payload`·`invalid_state`·`db_error`만 기록한다.
오류 본문·페이로드·자격 증명은 기록하지 않는다.

1. 필요하면 서비스 역할로 `lol_augment_data_sources`에 원본 URL·라이선스·출처를 등록한다.
   `source_id`는 선택이며, 지정한 출처가 비활성화되거나 `blocked_reason`이 있으면 수집·게시를 거부한다.
2. `acquire_lol_augment_ingestion_lease(p_client_patch, p_source_id default null, p_ttl_seconds default 600)`가 실행 UUID를 반환한다.
   TTL은 30~3600초다. 같은 패치의 활성 실행이 있으면 null이고, 만료된 실행은 `failed/lease_expired`로 보존한다.
   실행 ID가 소유권 토큰이므로 다른 실행이나 만료된 실행은 데이터를 쓸 수 없다. 잠금 대기 이후 DB 시각으로 만료를 검사한다.
3. `upsert_lol_augment_snapshot(p_run_id, p_client_patch, p_payload)`가 한 트랜잭션으로 전체 추출본을 저장하고 증강 수를 반환한다.
   JSONB 텍스트 UTF-8 8 MiB, 증강 1~1000개, 각 2개 언어, 각 최대 20개 별칭이다. 원본 stringtable은 RPC에 넣지 않는다.
   동일 실행·동일 페이로드 재호출은 SHA256으로 판별해 같은 결과를 반환한다. 같은 실행에 다른 페이로드를 보내면 거부한다.
   새 실행은 해당 미게시 패치의 상태·번역·변경 기록을 교체한다. 일부 행이 잘못되면 교체 전체가 롤백된다.
4. `record_lol_augment_patch_changes(p_run_id, p_client_patch, p_changes)`에 배열을 전달한다.
   UTF-8 1 MiB·최대 2000행이며 `(client_patch, platform_id, change_type, source_id)`로 멱등 upsert한다(null도 같은 키로 취급).
   `change_type`은 `added`·`removed`·`reenabled`·`changed`·`unannounced_absent`, `review_status`는 `pending`·`approved`·`rejected`다.
   `platform_id`가 null인 패치 전체 공지도 허용한다. `official`, `summary_ko`를 반드시 전달한다.
5. `finish_lol_augment_ingestion_run(p_run_id, p_status, p_error_code default null)`로 종료한다.
   상태는 `succeeded`·`review`·`blocked`·`failed`다. 성공·검토 상태에는 저장된 스냅샷이 필요하며 오류 코드를 함께 기록할 수 없다.
   동일 상태·사유 재호출은 멱등이다. TTL 안에 끝내야 하며, 실패·차단 시 현재 게시본은 그대로 둔다.
6. 관리자가 승인하면 `publish_lol_augment_patch(p_client_patch, p_run_id default null)`를 호출한다. 자동 수집 완료만으로 게시하지 않는다.
   마지막 실행이 성공·검토 상태이고 미해결 `pending` 변경이 없으며, 발행일·Data Dragon 버전·CDragon 버전·검증일이 확인돼야 한다.
   `review`의 승인 판단과 추출기의 차단 사유 확인은 호출하는 관리자 승인 경로의 책임이다. 이 PR은 승인 화면을 만들지 않는다.
   한 번 게시된 패치는 영구 동결한다. 수정 수집은 별도 계약 변경이 필요하다.
7. `get_lol_augment_catalog(p_client_patch default null)`은 현재 게시본 또는 명시한 과거 게시본 DTO를 반환한다.
   미게시 패치는 null이다. 실행·lease·원본 경로·원문 툴팁은 DTO에 넣지 않고, 승인된 변경과 표시용 텍스트·안전한 토큰만 반환한다.
   공개 HTTP 경로는 서버에서 서비스 역할로 이 RPC를 호출해야 한다. anon·authenticated에 EXECUTE를 주지 않는다.

페이로드 타입은 `AugmentSnapshot`·`AugmentLocalization`·`AugmentChange`를 따른다. 추출기 필드를 아래처럼 정규화한다.

| 추출 결과 | 저장 페이로드 |
| --- | --- |
| `platformId`, `nameId`, `rarity`, `isInternal` | `platform_id`, `name_id`, `rarity`, `is_internal` |
| `icons.small`, `icons.large` | `icon_small_path`, `icon_large_path` |
| `enabled`, `quest`, `ability`, `buildTags`, `augmentTags` | `enabled`, `quest`, `ability`, `build_tags`, `augment_tags` |
| `rootSpell.dataValues` | `data_values` (배열 전체, 0·빈 배열 보존) |
| `ko`·`en` 원문 | `localizations`의 `locale`, `name`, `description`, `tooltip_raw` |
| `chooseAugmentDisplay` 결과 | `display_source`, `display_text`, `tooltip_rendered` (선택한 표시 결과의 tokens) |
| 원본 tooltip 렌더링 상태 | `render_status` |

각 증강에는 `mode_name='KIWI'`, `in_pool`, 64자리 소문자 SHA256 `source_hash`가 필요하다.
`localizations`에는 두 언어가 각각 한 번 있어야 한다. 설명·표시 문구는 비어 있을 수 없고 32768자 이하이며, 이름은 누락을 null로 보존하고 256자 이하로 제한한다.
최상위 `patch`에는 `display_patch`, `released_at`, `ddragon_version`, `cdragon_version`, `notes_url_ko`, `notes_url_en`, `verified_at`을 넣는다.
`snapshot_path`는 `{client_patch}/{sha256}.json` 또는 허용된 종류 접두사 뒤 SHA256 경로다. 실행의 `snapshot_hash`는 원본 해시와 별도로 RPC 페이로드 정합성을 확인한다.

## 표시·검증 규칙 변경

패치 전체 미치환 비율 5% 차단은 제거했다. `tooltipTokenStats`는 진단 통계로 유지한다.
`chooseAugmentDisplay(tooltipResult, descriptionResult)`는 tooltip ok → desc ok → desc_partial 순서로 선택한다.
부분 설명은 미치환 토큰의 모든 출현을 `(수치 미확인)`으로 바꾸고 `일부 수치는 게임 안에서 확인하세요` 안내를 반환한다.
원문 HTML을 표시 결과로 쓰지 않는다. 원문과 표시용 토큰을 혼동하지 않는다.

`validateAugments`의 차단 조건은 일반 활성 풀 ±30% 초과·이름 누락 3개 초과, 전체 증강 등급 불일치, ko/en desc 누락이다.
`descriptions`와 `previousDescriptions`에는 같은 범위의 일반 증강(내부 제외, 비활성 포함)·같은 언어 구성으로 렌더링한 결과를 전달한다.
직전 대비 desc ok 비율이 10%p 넘게 떨어지면 `warnings:[{code:'review',...}]`만 남기며 `ok`를 false로 바꾸지 않는다.
렌더링 결과를 생략하면 Augment의 desc·rootSpell로 계산하므로 중첩 문자열이 있는 수집기는 반드시 같은 패치 stringtable로 렌더링한 결과를 전달한다.
직전 자료가 없으면 비율 하락 검증을 생략한다. CLI는 양쪽 stringtable로 현재 설명을 렌더링하며 언어별 `displays`도 출력한다.
16.21 실측의 tooltip 미치환 42.62% 자체는 더 이상 게시 차단 사유가 아니다.

## 비공개 Storage 버킷과 운영 확인

| 버킷 | 공개 여부 | MIME | 파일 상한 |
| --- | --- | --- | --- |
| `lol-augment-snapshots` | false | `application/json` | 67,108,864바이트 (64 MiB) |
| `lol-augment-evidence` | false | `image/png`, `image/jpeg`, `image/webp` | 5,242,880바이트 (5 MiB) |

스냅샷 원본 stringtable 약 35 MB를 고려해 64 MiB를 허용한다. 증거 버킷은 이 단계에서는 비어 있으며 업로드·보존 파이프라인은 구현하지 않는다.
`storage.objects`·`storage.buckets`에 서비스 역할 허용 정책과 anon·authenticated 대상 restrictive 차단 정책을 둔다.
기존의 넓은 허용 정책이 있어도 두 버킷의 조회·삽입·수정·삭제를 허용하지 않는다. 다른 버킷의 정책은 유지한다.
서비스 역할은 Storage API에서 RLS를 우회하므로 자격 증명은 서버에서만 사용한다.
근거: [Supabase Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control).

로컬 prerequisites는 Storage의 핵심 테이블·RLS·역할 권한만 재현한다. 검증은 버킷 메타데이터 상한·정책과 SQL 객체 접근을 확인한다.
실제 Storage API가 MIME·파일 크기를 거부하는지는 이 격리 PG17 검사 범위에 포함되지 않는다.
**운영 적용 때는 Storage 버킷 생성, public=false, MIME·용량 상한, 기존 정책과 실제 Storage API 거부 동작을 별도로 확인해야 한다.**

## 롤백 SQL

공개 버전 롤백은 이미 게시된 이전 패치를 가리킨다. 실제 이전 게시 패치로 인자를 바꾼다.
서비스 역할 전용이며 관리자 승인 경로에서 실행한다.

```sql
begin;
select public.publish_lol_augment_patch('16.20');
commit;
```

스키마 자체를 철회할 때는 먼저 수집·공개 호출을 중단하고 해당 테이블을 백업한다. 아래 SQL은 새로 만든 DB 객체의 데이터를 삭제한다.
Storage 원본 파일은 삭제하지 않는다. 파일 삭제는 별도 검토·승인 후 Storage API로 수행하고, 빈 버킷인지 확인한 뒤 버킷을 제거한다.

```sql
begin;
drop function public.get_lol_augment_catalog(text);
drop function public.publish_lol_augment_patch(text,uuid);
drop function public.finish_lol_augment_ingestion_run(uuid,text,text);
drop function public.record_lol_augment_patch_changes(uuid,text,jsonb);
drop function public.record_lol_augment_patch_notes(uuid,text,text,jsonb);
drop function public.upsert_lol_augment_snapshot(uuid,text,jsonb);
drop function public.acquire_lol_augment_ingestion_lease(text,uuid,integer);
drop table public.lol_augment_publication;
drop table public.lol_augment_patch_changes;
drop table public.lol_augment_patch_notes;
drop table public.lol_augment_aliases;
drop table public.lol_augment_ingestion_runs;
drop table public.lol_augment_data_sources;
drop table public.lol_augment_localizations;
drop table public.lol_augment_patch_states;
drop table public.lol_augments;
drop table public.lol_game_patches;
commit;
```

버킷의 파일을 보호하려고 이 단계에서는 restrictive 정책을 남긴다. 완전 철회 시 Storage API 정리를 끝낸 뒤 다음 SQL을 실행한다.

```sql
begin;
delete from storage.buckets b
where b.id in ('lol-augment-snapshots','lol-augment-evidence')
  and not exists (select 1 from storage.objects o where o.bucket_id=b.id);
-- 두 버킷이 모두 제거됐는지 확인한 다음 정책을 제거한다.
do $$
begin
  if exists (select 1 from storage.buckets where id in ('lol-augment-snapshots','lol-augment-evidence')) then
    raise exception '비어 있지 않은 증강 버킷이 남아 있습니다';
  end if;
end $$;
drop policy lol_augment_objects_service_all on storage.objects;
drop policy lol_augment_buckets_service_all on storage.buckets;
drop policy lol_augment_objects_service_only on storage.objects;
drop policy lol_augment_buckets_service_only on storage.buckets;
commit;
```

## 로컬 검증

```sh
npm run verify:core
npm run verify:lol
BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations
bash scripts/verify_lol_persistence_local.sh
```

증강 SQL 시나리오는 두 공개 역할의 테이블·RPC 권한 거부, 넓은 Storage 정책과의 교차 차단, 서비스 역할 쓰기,
JSON·행 수 상한, 입력 오류 전체 롤백, 멱등 저장, lease 경합·만료·소유권, 게시 전환·과거 조회·롤백을 확인한다.
`verify:migrations`는 실제 동시 lease 요청 2개 중 하나만 획득하는지도 확인한다.
운영 DB·Storage에는 연결하지 않는다. 2번 PR의 검증은 UI를 포함하지 않았으며 3번 PR의 화면 검증은 아래 절차를 따른다.


## 수집·검토 운영 (3번 PR)

`npx tsx scripts/lol_augments_ingest.ts --patch 16.21 --dry-run`은 Data Dragon 버전과 CommunityDragon 버전 폴더를 확인하고
고정한 버전의 원본 5종을 다운로드한다. `--patch`를 생략하면 Data Dragon의 최신 16.x를 사용한다.
`latest/`는 사용하지 않는다. 원본 파일당 64 MiB 상한은 기존 Storage 버킷 상한과 같고, 요청당 60초·최대 3회 지수 백오프·1초 간격을 적용한다.
고정 User-Agent는 `BGMS-augment-sync/1.0 (+https://bgms.kr)`다. HTTP 403은 `source_forbidden`으로 재시도 없이 종료한다.
JSON은 데이터로만 파싱하며 HTML 패치 노트는 이름·발행일 대조에만 쓰고 저장하지 않는다.

쓰기에는 `LOL_AUGMENT_INGEST_ENABLED=true`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`가 필요하다.
`--dry-run`은 서비스 역할 클라이언트를 만들지 않으며 DB 조회와 Storage 읽기·쓰기도 하지 않는다.
따라서 dry-run의 `baseline:none`은 게시본과 비교하지 않았다는 뜻이다. 첫 수집에서도 모든 현재 항목을 신규로 검토한다.
쓰기 모드는 직전 게시 실행의 manifest에서 전체 Augment·렌더링한 설명을 읽어 diff와 검증의 기준으로 사용한다.
같은 패치가 이미 게시돼 있으면 변경하지 않고 `already_published`로 건너뛴다.

원본은 `{client_patch}/{kind}-{sha256}.json`, 실행 manifest는 `{client_patch}/{sha256}.json`으로 비공개 버킷에 저장한다.
종류는 `augment-lists`, `cherry-augments`, `kiwi-bin`, `stringtable-ko`, `stringtable-en`, `manifest`만 허용한다.
동일 경로가 있으면 업로드하지 않는다. manifest는 원본 경로·추출 결과·설명 렌더링 결과·검증·공식 대조·이전 게시 패치를 보존한다.
검증 차단은 원본 업로드와 DB 스냅샷 저장 전에 `blocked/validation_blocked`로 종료한다.
추출·다운로드·Storage·DB 실패는 안전한 오류 코드로 실행을 종료하며 게시 RPC는 수집기에서 호출하지 않는다.

`record_lol_augment_patch_notes(p_run_id, p_client_patch, p_locale, p_notes)`는 유효한 실행 lease 아래에서
`lol_augment_patch_notes`에 URL·발행일·신규/삭제 이름 배열·파싱 상태·조회 시각을 저장한다.
`ko_kr`/`en_us`별 패치당 1행, JSON 1 MiB·목록별 1000개·이름 1~256자 제한이며 service_role 전용이다.
공식 아수라장 절의 신규 `p/strong`·목록, 삭제 목록을 이름으로 대조한다. 내부 항목은 자동 승인하지 않는다.
이름 일치만 `official=true/approved`, 불일치와 불완전한 파싱은 `pending`이다. 이름으로 연결할 수 없는 노트는 패치 전체 검토 항목 하나에 모은다.
발행일을 확인하지 못하면 패치 매핑도 미검증으로 남으므로 게시 RPC가 거부한다.

오프라인 예시:

```sh
npx tsx scripts/lol_augments_ingest.ts --patch 16.21 --dry-run --source-dir /path/to/pinned-sources
RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-augments-browser.test.ts
```

로컬 폴더에는 `{kind}.json` 5개 또는 패치 접두사가 붙은 기존 추출기 파일명을 둔다.
`patch-notes.html`이 있으면 로컬 공식 대조에 사용한다. 누락되면 네트워크 없이 파싱 실패·검토 대기로 처리한다.
기존 `latest_*` 원본은 16.21임을 확인한 뒤 별도 폴더에 `{kind}.json` 링크로 고정한다. 수집기가 latest라는 이름을 추측해서 읽지는 않는다.
같은 폴더에 직전 `{patch}_default_augment-lists.json`·`{patch}_default_cherry-augments.json`이 있으면
`offlinePoolDiff`에 구성·등급만 비교한다. 전체 이전 원본이 없으므로 설명·수치·enabled 변경 검증 결과로 해석하지 않는다.

관리자 경로는 `/admin/lol/augments`, API는 `/api/admin/lol/augments`다.
레이아웃·페이지·API에서 기존 LoL 관리자 가드를 사용하고, POST는 같은 출처·2048바이트 상한·`confirm:true`를 검사한다.
미검토 항목별 승인·제외 뒤 게시 확인을 체크해야 게시 버튼이 활성화된다. 쓰기 API에는 기존 `LOL_PERSISTENCE_ENABLED=true`도 필요하다.
관리자 API는 검토한 `runId`를 필수로 받고 게시 RPC에 전달한다.
DB 게시 gate는 패치 행 잠금 안에서 실행 ID 일치·마지막 실행·미해결 pending·패치 매핑을 다시 검사한다.
같은 패치가 검토 이후 재수집됐으면 게시를 거부한다. 서비스 역할의 기존 한 인자 롤백 호출은 계속 허용한다. DB 실패의 본문·자격 증명은 응답에 넣지 않는다.
운영 지표는 기존 `db_error`·`db_timeout`을 사용한다.

아이콘은 `/api/lol/augment-icons/{patch}/assets/ux/kiwi/augments/icons/{name}.png`로만 요청한다.
허용 목록은 `assets/ux/kiwi/augments/icons/*.png`와 `assets/ux/cherry/augments/icons/*.png` 두 디렉터리다.
실제 16.21 원본 중 kiwi 140개·cherry 108개 아이콘을 사용하므로 메인 승인에 따라 두 경로만 허용한다.
마법 미사일(id 1133)은 `assets/maps/particles/kiwi/`를 사용해 허용 목록 밖이며 미리보기 이미지를 생략한다.
패치·경로 허용 목록, PNG MIME·시그니처, 2 MiB 상한을 검사한다.
`LOL_PUBLIC_ENABLED=true`일 때 공개 1년 immutable 캐시, 그 외 관리자만 접근하며 private 1년 immutable 캐시를 사용한다.
HTML에 CommunityDragon 직접 아이콘 주소를 넣지 않는다.

`.github/workflows/lol-augments-sync.yml`의 수동 실행은 dry_run 기본 true다.
일일 schedule은 main에서 저장소 변수 `LOL_AUGMENT_SYNC_ENABLED=true`일 때만 실행한다.
쓰기 활성화는 별도 변수 `LOL_AUGMENT_INGEST_ENABLED=true`로 제어한다. 두 변수는 기본 비활성이다.
시크릿 이름은 기존 워크플로와 같은 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`다.

2026-10-23 로컬 확인: 249개, ko/en 각각 tooltip 85·desc 95·desc_partial 69, 검증 차단·경고 0개.
저장된 한국어 공식 HTML에서 신규 35·삭제 13개를 추출했다. 오프라인 구성 비교는 일반 신규 35·삭제 14·내부 신규 5개다.
실제 네트워크 dry-run 1회는 워커 환경의 CommunityDragon 403으로 중단했으며, 실제 다운로드 완주 검증은 메인이 수행한다.
운영 migration 적용·Storage API 실검증·첫 수집·첫 게시와 실기기 모바일 검증은 이 작업에서 실행하지 않는다.
