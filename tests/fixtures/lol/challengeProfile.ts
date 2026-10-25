export const challengeConfigFixture = [
  { id: 101, state: "ENABLED", tracking: "LIFETIME", localizedNames: { ko_KR: { name: "가상의 관찰자", description: "시야 점수를 기록하세요." } }, thresholds: { GOLD: 20 } },
  { id: 102, state: "ENABLED", tracking: "LIFETIME", localizedNames: { ko_KR: { name: "가상의 수호자", description: "아군을 구출하세요." } }, thresholds: { DIAMOND: 100 } },
  { id: 103, state: "ARCHIVED", tracking: "LIFETIME", localizedNames: { ko_KR: { name: "가상의 탐험가", description: "경기를 플레이하세요." } }, thresholds: { SILVER: 5 } },
  { id: 104, state: "ENABLED", tracking: "LIFETIME", localizedNames: { ko_KR: { name: "가상의 동료", description: "처치에 관여하세요." } }, thresholds: { GOLD: 30 } },
];
export const challengePercentilesFixture = { "101": { GOLD: 0.25 }, "102": { DIAMOND: 0.003 }, "103": { SILVER: 0.1 }, "104": { GOLD: 0.05 } };
export const challengePlayerFixture = {
  preferences: { title: "fixture-title-id", challengeIds: ["102"] },
  totalPoints: { level: "GOLD", current: 1234, max: 2000, percentile: 0.08 },
  categoryPoints: { EXPERTISE: { level: "SILVER", current: 240, percentile: 0.2 }, TEAMWORK: { level: "GOLD", current: 480, percentile: 0.1 } },
  challenges: [{ challengeId: 101, level: "GOLD", value: 30 }, { challengeId: 102, level: "DIAMOND", value: 150 },
    { challengeId: 103, level: "SILVER", value: 8 }, { challengeId: 104, level: "GOLD", value: 35 }],
};
