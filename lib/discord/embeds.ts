export interface StatsEmbedInput {
  nickname: string;
  platform: string;
  tier?: string | null;
  rp?: number | null;
  kda?: string | number | null;
  winRate?: string | null;
  avgDamage?: string | number | null;
  matches?: number | null;
}

export interface RecentMatchEmbedInput {
  nickname: string;
  platform: string;
  matchId: string;
  mapName?: string | null;
  winPlace?: number | null;
  kills?: number | null;
  damage?: number | null;
  damageShare?: string | null;
  backupLatency?: string | null;
  duelWinRate?: string | null;
}

export function buildLinkSuccessEmbed(params: { nickname: string; platform: string }) {
  return {
    embeds: [
      {
        title: "배틀그라운드 계정 연동 완료",
        description: `**${params.nickname}** (${params.platform.toUpperCase()}) 계정과 성공적으로 연동되었습니다.\n이제 닉네임 입력 없이 /전적 또는 /방금판 명령어를 바로 사용할 수 있습니다.`,
        color: 0x22c55e, // Green
        footer: { text: "BGMS 전적 봇" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function buildStatsEmbed(data: StatsEmbedInput, appUrl: string) {
  const encodedNick = encodeURIComponent(data.nickname);
  const platform = data.platform.toLowerCase();
  const webUrl = `${appUrl.replace(/\/+$/, "")}/stats/${platform}/${encodedNick}`;

  const fields = [
    { name: "현재 랭크", value: data.tier ? `${data.tier} (${data.rp ?? 0} RP)` : "언랭크", inline: true },
    { name: "KDA", value: String(data.kda ?? "—"), inline: true },
    { name: "승률", value: String(data.winRate ?? "—"), inline: true },
    { name: "평균 딜량", value: String(data.avgDamage ?? "—"), inline: true },
    { name: "분석 판수", value: `최근 ${data.matches ?? 20}경기`, inline: true },
    { name: "플랫폼", value: platform.toUpperCase(), inline: true },
  ];

  return {
    embeds: [
      {
        title: `🎮 ${data.nickname}님의 최근 전적 요약`,
        description: "자세한 전술 지표(반응 속도, 고립도, 백업 딜레이)와 AI 피드백은 웹사이트에서 확인하세요.",
        color: 0x3b82f6, // Blue
        fields,
        footer: { text: "BGMS 전적 분석" },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 5, // Link
            label: "🌐 웹에서 전체 전적 & AI 스타일 보기",
            url: webUrl,
          },
        ],
      },
    ],
  };
}

export function buildRecentMatchEmbed(data: RecentMatchEmbedInput, appUrl: string) {
  const encodedNick = encodeURIComponent(data.nickname);
  const platform = data.platform.toLowerCase();
  const webUrl = `${appUrl.replace(/\/+$/, "")}/stats/${platform}/${encodedNick}?matchId=${encodeURIComponent(data.matchId)}`;

  const rankText = `#${data.winPlace ?? "?"}위`;
  const mapText = data.mapName || "알 수 없음";

  const fields = [
    { name: "전투 성적", value: `${data.kills ?? 0}킬 / 딜량 ${data.damage ?? 0}`, inline: true },
    { name: "팀 딜량 비중", value: data.damageShare || "—", inline: true },
    { name: "1:1 교전 승률", value: data.duelWinRate || "—", inline: true },
    { name: "아군 백업 속도", value: data.backupLatency || "—", inline: true },
  ];

  return {
    embeds: [
      {
        title: `🔥 ${data.nickname}님의 최근 매치 (${rankText} · ${mapText})`,
        description: "방금 판의 상세 교전 분석과 AI 정밀 매운맛/다정한맛 코칭이 준비되어 있습니다.",
        color: data.winPlace === 1 ? 0xf59e0b : 0xef4444, // Gold or Red
        fields,
        footer: { text: "BGMS 매치 분석" },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 5, // Link
            label: "🎯 이 판 AI 정밀 코칭 & 전술 분석 보기",
            url: webUrl,
          },
        ],
      },
    ],
  };
}
