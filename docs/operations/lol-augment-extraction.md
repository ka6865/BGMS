# LoL 증강 순수 추출·툴팁 계약

설계 근거: [아수라장 콘텐츠 설계 6·11·14절](../plans/2026-10-23-aram-mayhem-content-design.md).
이 문서는 네트워크·DB·Next 없이 실행하는 1번 PR의 계약을 설명한다.

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
- `validate.ts`: `validateAugments`는 일반 활성 풀의 직전 대비 ±30% 초과, 일반 활성 풀 ko/en 이름 누락 3개 초과, 전체 풀 등급 불일치, 미치환 토큰 비율 5% 초과를 차단한다.
  렌더링 결과 배열은 검증할 언어·항목 전체를 전달해야 한다. 직전 추출본이 없으면 풀 변동 검증은 생략한다.

## 툴팁 수치 정책

- `@Var@`, `@Var*100@`, `@Var*-1@`, `@Var:Calc@`를 지원한다. 식을 실행하거나 `eval`하지 않는다.
- DataValues 배열은 0을 포함한 첫 유효값을 쓴다. 원본에 values가 없으면 빈 배열로 보존하고 치환 시 미확정으로 남긴다.
- 지원 계산: `GameCalculation`, `NumberCalculationPart`, `NamedDataValueCalculationPart`, `ByCharLevelInterpolationCalculationPart`, `SumOfSubPartsCalculationPart`, `ProductOfSubPartsCalculationPart`, `GameCalculationModified`.
- 레벨 보간은 최소~최대 범위로 표시한다. 합·곱과 음수 배수도 범위로 계산한다. `mDisplayAsPercent`는 명시 배수가 없을 때 100을 곱하고 `%`를 붙인다. 표시 수치는 소수점 4자리로 반올림한다.
- `{{문자열키}}`는 8단계까지 확장한다. 순환 참조, 누락, 미지원 계산과 런타임 토큰은 원래 토큰을 남긴다. 계산 참조·중첩도 16단계로 제한한다.
- 허용한 태그만 고정된 스타일 이름으로 바꾼다. `font`의 6자리 HEX 색은 공통 highlight 스타일로 바꾸며 속성·URL은 보존하지 않는다. 스크립트·스타일 블록은 내용까지 제거한다.
- 토큰 비율은 중첩 참조와 변수의 **출현 횟수**를 분모로 하고 미해결 출현 횟수를 분자로 한다. `unresolvedTokens` 목록은 중복을 제거하지만 횟수는 제거하지 않는다.
- `status`: 빈 결과는 failed, 미치환이 없으면 ok, 일부 토큰만 해결되면 partial, 전부 미해결이면 failed다. partial/failed는 공개 화면에서 원문 description으로 대체할 대상이다.

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
- ko/en 각각 793개 토큰 중 338개 미치환(42.62%), 각 164개 항목이 partial/failed다. 현재 게시 검증은 차단된다.
- 확인된 미지원 계산: `StatByCoefficientCalculationPart`, `StatByNamedDataValueCalculationPart`, `AbilityResourceByCoefficientCalculationPart`, `BuffCounterByCoefficientCalculationPart`, `BuffCounterByNamedDataValueCalculationPart`, `ByCharLevelBreakpointsCalculationPart`, `{e9a3c91d}`, `{ee18a47b}`.
- `f1/f2`, `SpellName` 등 엔진 런타임 토큰, RootSpell 밖의 값, 해시 이름 계산과 일부 계산 형식은 추가 해석이 필요하다. 미확정 값을 0으로 바꾸지 않았다.
- `tests/fixtures/lol-augments/`는 실제 목록·cherry의 필요한 필드, 대표 kiwi.bin·문자열, 패치 노트 35개 이름을 발췌한 자료다. JSON에 긴 문자열이 있는 대표 fixture는 문자열 연결을 사용하는 TypeScript 데이터로 저장해 한 줄 300자 제한을 지킨다.
- xxh3_64는 로컬 기준 라이브러리의 UTF-8 및 길이 경계 벡터 539개와 일치했다. 런타임·테스트 의존성은 추가하지 않았다.
- `npm run verify:core` 통과(기존 ESLint 경고 47개, 추가 파일 경고 없음), `npm run verify:lol` 292개 통과·41개 조건부 제외. 추가 테스트는 25개다.
- fixture 합계는 195,005바이트이며 전체 파일의 한 줄 길이는 300자 이하다. 이 작업 폴더에는 `.agents/rules/project_rules.md`가 없어 AGENTS.md·현재 구현·package.json·테스트를 기준으로 작업했다.
