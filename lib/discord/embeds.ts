export interface StatsEmbedInput {
  nickname: string;
  platform: string;
  tier?: string | null;
  rp?: number | null;
  kda?: string | number | null;
  winRate?: string | null;
  avgDamage?: string | number | null;
  matches?: number | null;
  scope: string;
  ranked: boolean;
  updatedAt?: string | null;
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
  tradeLatency?: string | null;
  duelWinRate?: string | null;
  playedAt?: string | null;
  storedAt?: string | null;
  analysisUpdatedAt?: string | null;
}

export function discordTime(value?: string | null): string {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : "미확인";
}

// 닉네임의 _ * ~ 등이 Discord 마크다운으로 해석되지 않도록 이스케이프한다.
export function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\*_~`|>])/g, "\\$1");
}

export function buildLinkSuccessEmbed(params: { nickname: string; platform: string }) {
  return {
    embeds: [
      {
        title: "배틀그라운드 계정 연동 완료",
        description: `**${escapeDiscordMarkdown(params.nickname)}** (${params.platform.toUpperCase()}) 계정과 성공적으로 연동되었습니다.\n이제 닉네임 입력 없이 /전적 또는 /방금판 명령어를 바로 사용할 수 있습니다.`,
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
    ...(data.ranked ? [{ name: "경쟁전 랭크 (집계 모드)", value: data.tier ? `${data.tier} (${data.rp ?? "미측정"} RP)` : "미확인", inline: true }] : []),
    { name: data.ranked ? "경쟁전 KDA" : "K/D", value: String(data.kda ?? "—"), inline: true },
    { name: "승률", value: String(data.winRate ?? "—"), inline: true },
    { name: "평균 딜량", value: String(data.avgDamage ?? "—"), inline: true },
    { name: "집계 판수", value: data.matches == null ? "미확인" : `${data.matches}경기`, inline: true },
    { name: "플랫폼", value: platform.toUpperCase(), inline: true },
    { name: "통계 갱신 시각", value: discordTime(data.updatedAt), inline: true },
  ];

  return {
    embeds: [
      {
        title: `🎮 ${escapeDiscordMarkdown(data.nickname)}님의 저장 전적 요약`,
        description: data.scope,
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
            label: "🌐 웹에서 전체 전적 보기",
            url: webUrl,
          },
        ],
      },
    ],
  };
}

/** 저장 기록이 없을 때 웹 전적 페이지에서 갱신하도록 안내한다. 공개 확인을 통과한 대상에만 쓴다. */
export function buildEmptyRecordMessage(content: string, nickname: string, platform: string, appUrl: string) {
  const webUrl = `${appUrl.replace(/\/+$/, "")}/stats/${platform.toLowerCase()}/${encodeURIComponent(nickname)}`;
  return {
    content,
    components: [
      {
        type: 1, // Action Row
        components: [{ type: 2, style: 5, label: "🌐 웹에서 전적 갱신하기", url: webUrl }],
      },
    ],
  };
}

export function buildRecentMatchEmbed(data: RecentMatchEmbedInput, appUrl: string) {
  const encodedNick = encodeURIComponent(data.nickname);
  const platform = data.platform.toLowerCase();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(data.matchId) || ["latest", ".", ".."].includes(data.matchId)) throw new Error("invalid_match_id");
  const webUrl = `${appUrl.replace(/\/+$/, "")}/stats/${platform}/${encodedNick}/matches/${encodeURIComponent(data.matchId)}`;

  const rankText = `#${data.winPlace ?? "?"}위`;
  const mapText = data.mapName || "알 수 없음";

  const fields = [
    { name: "전투 성적", value: `${data.kills ?? "미측정"}킬 / 딜량 ${data.damage ?? "미측정"}`, inline: true },
    { name: "팀 딜량 비중", value: data.damageShare ?? "미측정", inline: true },
    { name: "1:1 교전 승률", value: data.duelWinRate ?? "미측정", inline: true },
    { name: "평균 복수 처치 시간", value: `${data.tradeLatency ?? "미측정"}\n아군 기절 → 복수 처치`, inline: true },
    { name: "경기 시각", value: discordTime(data.playedAt), inline: true },
    { name: "기록 저장 시각", value: discordTime(data.storedAt), inline: true },
    { name: "분석 갱신 시각", value: discordTime(data.analysisUpdatedAt), inline: true },
  ];

  return {
    embeds: [
      {
        title: `🔥 ${escapeDiscordMarkdown(data.nickname)}님의 최신 저장 경기 (${rankText} · ${mapText})`,
        description: "저장된 기록 중 경기 시각이 가장 최신인 1건입니다. 방금 종료한 경기나 전체 플레이 기록과 다를 수 있습니다.\n상세 페이지에서 분석 및 AI 코칭의 제공 여부를 확인해 주세요.",
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
            label: "🎯 경기 상세 보기",
            url: webUrl,
          },
        ],
      },
    ],
  };
}
