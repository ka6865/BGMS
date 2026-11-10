/** PUBG 텔레메트리 character.zone 지역 ID를 해설에 쓰는 한글 지명으로 바꾸고, 좌표로 가까운 지명을 찾는다. */
const PLACE_NAMES: Record<string, string> = {
  // 에란겔
  pochinki: "포친키", sosnovkamilitarybase: "소스노브카 군사기지", militarybase: "군사기지", yasnayapolyana: "야스나야 폴랴나",
  georgopol: "게오르고폴", rozhok: "로족", mylta: "밀타", myltapower: "밀타 파워", quarry: "채석장", farm: "농장",
  ferrypier: "페리 선착장", gatka: "가트카", school: "학교", primorsk: "프리모르스크", novorepnoye: "노보레프노예",
  lipovka: "리포브카", zharki: "자르키", severny: "세베르니", stalber: "스탈버", kameshki: "카메시키",
  hospital: "병원", prison: "감옥", mansion: "저택", ruins: "유적", shelter: "대피소", shootingrange: "사격장",
  // 미라마
  losleones: "로스 레오네스", sanmartin: "산 마르틴", elpozo: "엘 포조", elazahar: "엘 아자하르", chumacera: "추마세라",
  brickyard: "벽돌 공장", haciendadelpatron: "아시엔다 델 파트론", montenuevo: "몬테 누에보", oasis: "오아시스",
  truckstop: "트럭 휴게소", gdtruckstop: "트럭 휴게소", manisgenerales: "미나스 헤네랄레스", lacobreria: "라 코브레리아",
  cruzdelvalle: "크루즈 델 바예", pecado: "페카도", impala: "임팔라", valledelmar: "바예 델 마르",
  puertoparaiso: "푸에르토 파라이소", campomilitar: "캄포 밀리타르", stadium: "경기장", alcantara: "알칸타라",
  cantera: "칸테라", craterfields: "크레이터 필드", graveyard: "묘지", partona: "파르토나", powergrid: "발전소",
  tierrabronca: "티에라 브롱카", watertreatment: "정수장",
  // 론도
  danching: "단칭", hungshan: "훙산", jadenacity: "제이드나 시티", jaotin: "자오틴", lohuaxing: "로화싱",
  longho: "롱호", meyran: "메이란", nanchuan: "난촨", neoxfactory: "네오엑스 공장", testtrack: "테스트 트랙", yulin: "위린",
  beili: "베이리", fongtun: "펑툰", kunxia: "쿤샤", lanpo: "란포", muhopan: "무호판", raian: "라이안",
  tinlonggarden: "틴롱 가든", tuling: "투링", yungu: "윈구",
  // 태이고
  hapo: "하포", hosan: "호산", terminal: "터미널", palace: "궁전", boatyard: "조선소", buksansa: "북산사",
  haemoosa: "해무사", hosanprison: "호산 교도소", kangneung: "강릉", ohhyang: "오향",
};

/**
 * 맵별 지역 중심 좌표와 반경(m) [x, y, r]. 2026-10-28~11-09 랭커 경기 텔레메트리 16건에서
 * zone이 하나만 붙은 위치 기록의 중앙값과 90% 거리로 만들었다. 반경 1km가 넘게 퍼진 지역은 뺐다.
 * shortcut: 비켄디·데스턴 등 표본이 없는 맵은 지명을 붙이지 않는다. 그 맵이 해설에 나오면 같은 방식으로 추가한다.
 */
const PLACE_CENTERS: Record<string, Record<string, [number, number, number]>> = {
  "에란겔": { boatyard: [3492, 3191, 140], farm: [5399, 4571, 151], ferrypier: [2798, 5731, 276], gatka: [2180, 3958, 87], georgopol: [1722, 2759, 698], kameshki: [6666, 1004, 184], lipovka: [7080, 3338, 173], mansion: [6244, 3035, 74], mylta: [6026, 4812, 209], myltapower: [6880, 4339, 402], novorepnoye: [6160, 6099, 196], pochinki: [3636, 4069, 172], primorsk: [1701, 6139, 254], prison: [6175, 3789, 144], quarry: [1622, 5299, 195], rozhok: [4054, 2914, 278], ruins: [3119, 3271, 229], school: [4368, 3317, 229], severny: [3867, 1222, 140], shelter: [5621, 3824, 114], shootingrange: [3376, 1662, 144], sosnovkamilitarybase: [4506, 6408, 507], stalber: [5810, 1308, 121], yasnayapolyana: [5434, 2367, 342], zharki: [1127, 1354, 176] },
  "미라마": { alcantara: [912, 2211, 140], brickyard: [1911, 4618, 118], campomilitar: [5735, 732, 322], cantera: [5066, 4274, 124], chumacera: [2665, 5277, 180], craterfields: [2090, 2015, 182], cruzdelvalle: [5497, 1559, 172], elazahar: [6367, 2585, 162], elpozo: [1619, 2826, 433], graveyard: [4466, 3652, 108], haciendadelpatron: [4371, 2803, 72], impala: [6375, 4707, 125], lacobreria: [2513, 1313, 243], losleones: [4823, 5351, 170], manisgenerales: [5036, 3648, 319], montenuevo: [1820, 4219, 249], oasis: [3683, 621, 195], partona: [3468, 7552, 163], pecado: [3693, 4391, 175], powergrid: [3252, 3505, 126], prison: [1243, 6999, 119], puertoparaiso: [6290, 6216, 227], sanmartin: [3713, 2967, 276], tierrabronca: [6566, 1170, 184], truckstop: [6176, 3082, 212], valledelmar: [1501, 5957, 414], watertreatment: [4304, 1910, 225] },
  "론도": { beili: [1081, 1767, 155], danching: [4919, 5182, 120], fongtun: [931, 5106, 192], hungshan: [3672, 6376, 112], jadenacity: [6902, 5842, 536], jaotin: [1718, 3429, 319], kunxia: [5328, 1086, 104], lanpo: [1368, 5889, 94], lohuaxing: [5924, 3093, 138], meyran: [6418, 3488, 160], muhopan: [5991, 1596, 159], nanchuan: [2466, 841, 256], neoxfactory: [4880, 3722, 134], raian: [3897, 907, 94], stadium: [2800, 2462, 292], testtrack: [4609, 3542, 322], tinlonggarden: [4896, 7169, 173], tuling: [5597, 5755, 168], yulin: [3040, 4455, 187], yungu: [6351, 4477, 53] },
  "태이고": { buksansa: [5126, 5141, 169], haemoosa: [1036, 2491, 108], hapo: [722, 4418, 118], hosan: [3389, 5028, 205], hosanprison: [1876, 5861, 78], hospital: [5680, 6749, 194], kangneung: [6394, 4454, 177], ohhyang: [5590, 6006, 234], palace: [2963, 3675, 127], school: [3171, 6365, 141], terminal: [4725, 3622, 203] },
};
/** 지역 반경 밖이어도 이 거리 안이면 "인근"으로 부른다. 그보다 멀면 지명 없는 들판으로 본다. */
const NEARBY_METERS = 500;

/** "truckstop, GDTruckStop"처럼 겹친 지역은 첫 지명 하나만 쓴다. 사전에 없는 ID는 원문을 그대로 둔다. */
export function dailyPlaceLabel(raw: string | null | undefined): string | null {
  const first = (raw ?? "").split(",").map((part) => part.trim()).find(Boolean);
  return first ? PLACE_NAMES[first.toLowerCase()] ?? first : null;
}

/** 미터 좌표에서 가장 가까운 지역명을 찾는다. 지역 안이면 지명, 가까우면 "지명 인근", 멀면 null. */
export function dailyNearbyPlace(mapName: string, point: { x: number; y: number } | null | undefined): string | null {
  const centers = PLACE_CENTERS[mapName];
  if (!centers || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const nearest = Object.entries(centers).map(([id, [x, y, radius]]) => ({ id, gap: Math.hypot(point.x - x, point.y - y) - radius }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (!nearest || nearest.gap > NEARBY_METERS) return null;
  return PLACE_NAMES[nearest.id] + (nearest.gap > 0 ? " 인근" : "");
}
