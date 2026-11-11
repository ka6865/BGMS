# 지형 하이트맵 교체와 3D 건물 레이어 (2026-11-11)

## 변경
- `public/assets/map/{Map}_HeightMap.jpg`(8비트 JPG)를 `{Map}_HeightMap.png`(8비트 흑백 무손실)로 바꿨다. 대상: Erangel, Miramar, Vikendi, Taego, Deston, Rondo.
- 높이 공식은 `(값 - 128) × 2m`다(`lib/heightmapCoords.ts`의 `heightmapElevationMeters`). 기존 JPG 공식의 2.048은 실제 한 단계 2m보다 2.4% 컸다.
- 건물을 뺀 지형만 담는다. 건물은 `{Map}_Buildings.json`(중심 x·y, 폭, 길이, 회전각, 높이 m, 맵 8192 좌표)으로 따로 두고 3D 리플레이가 상자로 그린다.
- 소비처: 3D 리플레이(`app/replay/3d/page.tsx`), 지도 박격포 고저차(`components/map/MapView.tsx`). 박격포는 두 지점의 차이를 쓰므로 영향은 배율 2.4% 정도다.

## 생성
`scripts/maps/build_heightmap_assets.py <16비트 PNG> <건물 없는 기준 지형> <맵> public/assets/map`
- 입력 16비트 PNG는 값 32768이 0m, 64가 1m이며 건물 높이가 섞여 있다. 값 65535 영역(가장자리 표식)은 지형으로 메운다.
- 기준 지형(이전 JPG)보다 3m 이상 솟고 지붕이 평평하며(곡률 2 이하) 벽이 가파른(가장자리 기울기/높이 0.25 이상) 덩어리만 건물로 본다. 바위 지대·절벽·고가도로·경기장 고리는 빠진다.
- 원본 16비트 파일과 출처는 저장소에 넣지 않는다.

## 검증
- 론도 1경기 도보 위치 3,946개 기준 지형과 선수 높이 차 중앙값 약 0.8m(기존 JPG 약 2.5m).
- 6개 맵 방향과 기준 지형 상관 0.93~0.99, 높이 배율 맞춤값 2.006~2.018.
- 건물 수: Erangel 2,394 / Miramar 2,998 / Vikendi 1,867 / Taego 2,354 / Deston 3,856 / Rondo 2,625.

## 한계
- 지형 자체는 여전히 2m 단계다. 건물은 사각형 상자로 근사하며 L자·고리형 구조물과 일부 경사 지붕 건물은 빠질 수 있다.
