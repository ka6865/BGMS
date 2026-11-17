# GTA6 서브 지도

`/gta6`는 GTADB의 커뮤니티 추정 지도를 사용하는 독립 콘텐츠다. 한국어·영어·ID 검색, 분류 필터, 즐겨찾기, 방문 체크, 장소 링크 공유를 제공한다. 한국어 명칭·지역명은 검색용 음역/번역이며 공식 번역으로 확정하지 않는다.

## 데이터와 출처

- 원본: https://github.com/rolux/gtadb.org
- commit: `5c1d69ff864623d181da5457afaacd00b623e1a4`
- 타일: `maps/tiles/6/yanis,17` → `public/gta6/tiles/yanis-17`, 8,830개, 43,805,053바이트
- 장소: `map/data/6/landmarks.json` → `public/gta6/landmarks.json`, 3,431개 중 좌표가 있는 3,340개 표시
- 출처·해시·수량: `public/gta6/manifest.json`
- 원본 타일과 JSON은 내용 변경 없이 보관한다. 한국어 검색어·표시명·분류는 `lib/gta6/map.ts`에서 별도로 추가한다.
- 데이터/타일: CC BY 4.0, `gtadb.org and all contributors`. 라이선스 안내: `public/gta6/LICENSE.txt`.

원본 사이트에 라이브 요청하거나 핫링크하지 않는다. 외부 사진은 배포하지 않는다. 지역/건물의 위치·명칭·현실 대응은 확정된 게임 정보가 아니며, `unconfirmed` 태그는 현실 매칭 미확인으로 표시한다. 좌표가 없으면 마커와 검색 목록에서 제외한다.

## 좌표와 타일

원본 world 좌표 `(x, y)`를 Leaflet `CRS.Simple`의 `(lat, lng) = (y - 16384, x + 16384)`로 바꾼다. Leaflet 줌 0에서 원본 줌 5의 32768px 평면에 대응한다. `zoomOffset=5`, `minNativeZoom=-5`, `maxNativeZoom=0`을 사용한다. 파일 경로는 `{z}/{z},{y},{x}.jpg`이며 z=5 범위는 행 21~99, 열 21~103이다. 줌 0보다 확대하면 기존 타일을 확대하며, -5보다 축소하면 원본 줌 0을 축소한다. Leaflet 줌 -4 미만에서는 이름이 있는 장소를 우선 표시해 마커 겹침을 줄이고, 확대하면 이름 미확인 장소까지 표시한다. 선택한 장소는 항상 표시한다.

## 로컬 저장과 공유

- 저장 키: `bgms:gta6:progress:v1`
- 형식: `{ version: 1, favorites: string[], visited: string[] }`
- ID를 기준으로 저장하므로 원본 갱신에서 순서가 바뀌어도 기록이 유지된다. 현재 데이터에서 사라진 ID는 목록·개수에서 제외한다.
- 저장소가 차단되면 화면 상태를 유지하고 영구 저장이 되지 않을 수 있음을 알린다. 손상·지원하지 않는 버전은 빈 목록으로 읽는다.
- 공유 주소: `/gta6#L25`. 새로고침과 뒤로/앞으로 가기를 지원한다. 존재하지 않거나 좌표 없는 ID는 안내한다.
- 방문 기록은 게임이나 계정과 동기화하지 않는다. 신규 DB·API·외부 서비스 쓰기는 없다.

## 갱신

별도 임시 폴더에서 원본을 sparse checkout한다. 앱 저장소에 원본 `.git` 폴더를 넣지 않는다.

```bash
git clone --filter=blob:none --depth 1 --sparse https://github.com/rolux/gtadb.org /tmp/bgms-gta6-upstream
git -C /tmp/bgms-gta6-upstream sparse-checkout set map/data/6 'maps/tiles/6/yanis,17'
git -C /tmp/bgms-gta6-upstream rev-parse HEAD
```

가져온 commit과 변경 내용을 검토한 뒤 해당 JSON·타일만 복사하고 manifest의 commit·날짜·해시·수량을 갱신한다. 타일 버전이 바뀌면 새 디렉터리로 추가하고 지도 URL과 좌표 보정을 함께 바꾼다. 기존 버전 삭제와 운영 배포는 별도 작업이다. 데이터 라이선스와 사진 원본의 권리를 같은 것으로 취급하지 않는다.

```bash
npm run verify:core
npx vitest run tests/gta6-map.test.ts tests/home-hub.test.ts
npm run test:unit
```

브라우저에서 검색·분류·빈 결과·데이터 재시도·타일 재시도·선택/공유·즐겨찾기/방문 저장을 확인한다. 최소 뷰포트는 375x667, 390x844, 430x932와 데스크톱이다. 실제 iOS/Android 기기 검증과 웹 뷰포트 검증을 구분한다.

## 2026-11-17 구현 검증

- `npm run verify:core`: Node 24, `NODE_OPTIONS=--max-old-space-size=4096`에서 통과. 기존 경고 43건, 오류 0건.
- 전체 Vitest: `vitest run --maxWorkers=4 --testTimeout=20000`, 519개 파일 통과, 7,045개 테스트 통과, 조건부 388개 skip.
- 데이터·홈·독립 레이아웃 및 재검증: 6개 파일 55개 통과. 초기 전체 실행은 자원 경합과 수정 중 회귀 테스트가 섞여 실패했으며, 코드 고정 후 전체 재실행으로 확인했다.
- 격리 Chrome: 375x667, 390x844, 430x932, 1440x900에서 문서 가로/세로 넘침 없음. 검색·분류·빈 결과·장소 선택·즐겨찾기/방문 reload 유지·실제 클립보드 복사·공유 ID와 뒤로/앞으로·데이터 503 후 재시도 통과. 정상 시 GTA6 자산 HTTP 오류와 JS 오류 0건.
- 추가 경계 검증: 타일 503 후 재시도와 localStorage 차단 안내 통과. 홈도 동일한 4개 뷰포트에서 GTA6 진입과 가로 넘침 없음을 확인했다.
- 원본 타일 행/열 전도는 실제 z=5 파일명 전체를 비교하는 회귀 테스트로 수정했다. 타일 확대/축소와 선택 툴팁은 브라우저에서 확인했다.
- iOS Safari/Android WebView·실기기, 운영 배포, 3D·게임 진행도 동기화는 검증/구현 범위 밖이다.
