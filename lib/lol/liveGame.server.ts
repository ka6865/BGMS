import "server-only";
import { getLolChampions } from "./champions.server";
import { getLolChampionStats } from "./championStats.server";
import { lolStatTierFilter, type LolChampionStatRow } from "./championStats";
import {
  LOL_LIVE_CLASSIC_QUEUE, LOL_LIVE_NOTICE, LOL_LIVE_QUEUE_LABELS, LolLiveParseError, isUnsupportedLiveGame, liveChampionStat,
  liveWinRate, parseLiveCurrentGame, pickLiveSoloEntry, type LolLiveChampionStat, type LolLiveCurrentGame, type LolLiveFailureKind,
  type LolLiveGameView, type LolLiveNamedImage, type LolLiveParticipantView, type LolLiveRank,
} from "./liveGame";
import { getLolBuildCatalog, parseRiotId, requestJson, RiotSearchError } from "./riotSearch.server";

// 진행 중 경기 조회는 DB에 저장하지 않는다. 짧은 프로세스 메모리 캐시로 같은 조회의 반복 호출만 합친다.
// 원문 응답은 캐시하지 않고, 파서가 만든 값(필요한 식별자 포함)만 짧게 보관한다.
const DDRAGON = "https://ddragon.leagueoflegends.com";
const TTL = { account: 10 * 60_000, spectator: 20_000, entries: 60_000, stats: 10 * 60_000 } as const;
const MAX_ENTRIES = 500;

type CacheEntry = { expiresAt: number; value: unknown };
type LiveState = { cache: Map<string, CacheEntry>; inflight: Map<string, Promise<unknown>> };
const LIVE_STATE = Symbol.for("bgms.lol.live-state");
const live = ((globalThis as typeof globalThis & { [LIVE_STATE]?: LiveState })[LIVE_STATE] ??= {
  cache: new Map(),
  inflight: new Map(),
});

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = live.cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const pending = live.inflight.get(key);
  if (pending) return pending as Promise<T>;
  // 실패한 조회는 캐시하지 않는다. 다음 요청이 Riot에 다시 확인한다.
  const run = (async () => {
    try {
      const value = await load();
      if (live.cache.size >= MAX_ENTRIES) {
        const oldest = live.cache.keys().next().value;
        if (oldest !== undefined) live.cache.delete(oldest);
      }
      live.cache.delete(key);
      live.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      live.inflight.delete(key);
    }
  })();
  live.inflight.set(key, run);
  return run;
}

type Account = { puuid: string; gameName: string; tagLine: string };
type SpectatorState = { found: false } | { found: true; game: LolLiveCurrentGame };
type StatsSnapshot = { patch: string | null; matches: number; rows: LolChampionStatRow[] };

async function loadAccount(gameName: string, tagLine: string): Promise<Account> {
  const raw = await requestJson<Partial<Account> | null>("asia",
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, 0);
  if (typeof raw?.puuid !== "string" || !raw.puuid || typeof raw.gameName !== "string" || typeof raw.tagLine !== "string") {
    throw new RiotSearchError("upstream");
  }
  return { puuid: raw.puuid, gameName: raw.gameName, tagLine: raw.tagLine };
}

// 404는 진행 중 경기가 없다는 뜻이다(spectator 응답의 404만 이렇게 본다).
async function loadSpectator(puuid: string): Promise<SpectatorState> {
  try {
    const raw = await requestJson<unknown>("kr", `/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`, 0);
    return { found: true, game: parseLiveCurrentGame(raw) };
  } catch (error) {
    if (error instanceof RiotSearchError && error.kind === "not_found" && error.diagnostic?.endpoint === "spectator") return { found: false };
    if (error instanceof LolLiveParseError) throw new RiotSearchError("upstream");
    throw error;
  }
}

async function loadRank(puuid: string): Promise<LolLiveRank> {
  const entry = pickLiveSoloEntry(await requestJson<unknown>("kr", `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`, 0));
  if (entry === "invalid") throw new RiotSearchError("upstream");
  if (!entry) return { status: "unranked" };
  return { status: "ranked", ...entry, winRate: liveWinRate(entry.wins, entry.losses) };
}

async function loadStats(tiers: readonly string[]): Promise<StatsSnapshot> {
  const result = await getLolChampionStats([...tiers]);
  return { patch: result.patch, matches: result.matches, rows: result.rows };
}

function failureKind(error: unknown): LolLiveFailureKind {
  if (!(error instanceof RiotSearchError)) return "upstream";
  switch (error.kind) {
    case "rate_limited": return "rate_limited";
    case "key_or_permission":
    case "unconfigured": return "key_or_permission";
    case "congested":
    case "busy": return "congested";
    case "timeout": return "timeout";
    default: return "upstream";
  }
}

// 참가자 한 명의 랭크·챔피언 통계를 조회한다. 익명·봇 참가자에게는 Riot 호출을 하지 않는다.
export async function getLolLiveGame(input: { riotId: unknown; tier?: unknown }): Promise<LolLiveGameView> {
  const riotId = parseRiotId(input.riotId);
  if (!riotId) throw new RiotSearchError("invalid_request");
  const tier = lolStatTierFilter(input.tier);
  const lookedUpAt = new Date().toISOString();

  const account = await cached(`account:${riotId.gameName.toLocaleLowerCase()}#${riotId.tagLine.toLocaleLowerCase()}`, TTL.account,
    () => loadAccount(riotId.gameName, riotId.tagLine));
  const displayName = `${account.gameName}#${account.tagLine}`;
  const spectator = await cached(`spectator:${account.puuid}`, TTL.spectator, () => loadSpectator(account.puuid));
  if (!spectator.found) return { status: "not_in_game", riotId: displayName, lookedUpAt };

  const game = spectator.game;
  const queue = { id: game.queueId, label: LOL_LIVE_QUEUE_LABELS[game.queueId] ?? null };
  // 커스텀 게임은 참가자와 밴을 노출하지 않고 같은 모양의 빈 결과로 돌려준다.
  if (isUnsupportedLiveGame(game)) return { status: "unsupported_mode", riotId: displayName, lookedUpAt, queue };

  const [championCatalog, runeCatalog] = await Promise.all([getLolChampions().catch(() => null), getLolBuildCatalog().catch(() => null)]);
  const version = runeCatalog?.version ?? championCatalog?.version ?? null;
  const championById = new Map((championCatalog?.champions ?? []).map(item => [item.id, item]));
  const championIcon = (id: number) => {
    const item = championById.get(id);
    return item && version ? `${DDRAGON}/cdn/${version}/img/champion/${item.imageId}.png` : null;
  };
  const championName = (id: number) => championById.get(id)?.name ?? null;

  // 챔피언 통계는 솔로 랭크(420) 집계만 있으므로 그 큐에서만 조회한다.
  const classic = game.queueId === LOL_LIVE_CLASSIC_QUEUE;
  let stats: StatsSnapshot | null = null;
  if (classic) stats = await cached(`stats:${tier.id}`, TTL.stats, () => loadStats(tier.tiers)).catch(() => null);
  const statsOk = !!stats?.patch;

  const participants = await Promise.all(game.participants.map(async (item): Promise<LolLiveParticipantView> => {
    const identity = item.identity;
    const rank: LolLiveRank = identity.status === "visible"
      ? await cached(`entries:${identity.puuid}`, TTL.entries, () => loadRank(identity.puuid)).catch(error => ({ status: "failed" as const, reason: failureKind(error) }))
      : { status: "hidden" };
    const runeImage = (id: number | null): LolLiveNamedImage | null => {
      const rune = id === null ? undefined : runeCatalog?.runes[String(id)];
      return rune ? { name: rune.name, iconUrl: `${DDRAGON}/cdn/img/${rune.icon}` } : null;
    };
    const champion: LolLiveChampionStat = !classic ? { status: "not_applicable" }
      : statsOk && stats ? liveChampionStat(item.championId, stats.rows, stats.matches)
        : { status: "unavailable" };
    return {
      teamId: item.teamId,
      championId: item.championId,
      championName: championName(item.championId),
      championIconUrl: championIcon(item.championId),
      spells: [item.spell1Id, item.spell2Id].map((id): LolLiveNamedImage => {
        const spell = id === null ? undefined : runeCatalog?.spells[String(id)];
        return { name: spell?.name ?? null, iconUrl: spell && version ? `${DDRAGON}/cdn/${version}/img/spell/${spell.image}` : null };
      }),
      keystone: runeImage(item.perkIds[0] ?? null),
      primaryPath: runeImage(item.perkStyle),
      secondaryPath: runeImage(item.perkSubStyle),
      identity: identity.status === "visible" ? { status: "visible", riotId: identity.riotId } : { status: identity.status },
      rank,
      champion,
    };
  }));

  return {
    status: "ready",
    riotId: displayName,
    lookedUpAt,
    queue,
    gameLengthSeconds: game.gameLengthSeconds,
    bans: game.bans.map(ban => ({ teamId: ban.teamId, championId: ban.championId, championName: championName(ban.championId), championIconUrl: championIcon(ban.championId) })),
    participants,
    rankFailureCount: participants.filter(item => item.rank.status === "failed").length,
    championStats: {
      status: !classic ? "not_applicable" : statsOk ? "ok" : "unavailable",
      patch: stats?.patch ?? null,
      matches: stats?.matches ?? 0,
      tierFilter: tier.id,
      tierLabel: tier.label,
    },
    notice: LOL_LIVE_NOTICE,
  };
}
