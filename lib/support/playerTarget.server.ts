import { createPlayerApiClient, PlayerApiError } from "@/lib/pubg/playerApiClient";
import { isPlayerPayload } from "@/lib/pubg/playerPayload";
import type { SupportDb, SupportPlatform } from "./contracts";

const ACCOUNT_ID_PATTERN = /^account\.[A-Za-z0-9_-]+$/;
const PLATFORMS = new Set<SupportPlatform>(["steam", "kakao"]);

export type SupportPlayerLookupCode = "not_found" | "rate_limited" | "unavailable";

export class SupportPlayerLookupError extends Error {
  readonly code: SupportPlayerLookupCode;

  constructor(code: SupportPlayerLookupCode) {
    super(code === "not_found"
      ? "플레이어를 찾을 수 없습니다. 플랫폼과 닉네임을 확인해 주세요."
      : code === "rate_limited"
        ? "플레이어 조회 요청이 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요."
        : "플레이어 조회를 일시적으로 완료할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    this.name = "SupportPlayerLookupError";
    this.code = code;
  }
}

export type ResolvedSupportPlayer = {
  platform: SupportPlatform;
  requestedNickname: string;
  canonicalNickname: string;
  accountId: string;
};

function normalizeNickname(value: string): string {
  return value.trim();
}

function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value.trim());
}

function fromCacheRow(
  row: unknown,
  platform: SupportPlatform,
  requestedNickname: string,
): ResolvedSupportPlayer | null {
  if (!row || typeof row !== "object") return null;
  const candidate = row as { id?: unknown; nickname?: unknown };
  if (!isAccountId(candidate.id)) return null;
  const canonicalNickname = typeof candidate.nickname === "string" && candidate.nickname.trim()
    ? candidate.nickname.trim()
    : requestedNickname;
  return {
    platform,
    requestedNickname,
    canonicalNickname,
    accountId: candidate.id.trim(),
  };
}

function lookupError(error: unknown): SupportPlayerLookupError {
  if (error instanceof SupportPlayerLookupError) return error;
  if (error instanceof PlayerApiError) {
    if (error.upstreamStatus === 404) return new SupportPlayerLookupError("not_found");
    if (error.upstreamStatus === 429) return new SupportPlayerLookupError("rate_limited");
  }
  return new SupportPlayerLookupError("unavailable");
}

export async function resolveSupportPlayerTarget(input: {
  platform: SupportPlatform;
  nickname: string;
  supabaseAdmin: SupportDb;
  signal?: AbortSignal;
}): Promise<ResolvedSupportPlayer> {
  const requestedNickname = normalizeNickname(input.nickname);
  if (!PLATFORMS.has(input.platform) || !requestedNickname) {
    throw new SupportPlayerLookupError("not_found");
  }

  try {
    const { data } = await (input.supabaseAdmin as any)
      .from("pubg_player_cache")
      .select("id,nickname,lower_nickname,platform")
      .eq("platform", input.platform)
      .eq("lower_nickname", requestedNickname.toLowerCase())
      .maybeSingle();
    const cached = fromCacheRow(data, input.platform, requestedNickname);
    if (cached) return cached;
  } catch {
    // A cache outage must not prevent a server-side canonical lookup.
  }

  const signal = input.signal ?? new AbortController().signal;
  const apiKey = (process.env.PUBG_API_KEY ?? "").trim().split(/\s+/, 1)[0] ?? "";
  const api = createPlayerApiClient({
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
    },
    signal,
  });

  try {
    const url = `https://api.pubg.com/shards/${input.platform}/players?filter[playerNames]=${encodeURIComponent(requestedNickname)}`;
    const payload = await api.read(url, {
      stage: "support-player-target",
      validate: isPlayerPayload,
    });
    const player = payload.data.find((candidate) => (
      candidate.attributes.name.trim().toLowerCase() === requestedNickname.toLowerCase()
    ));
    if (!player || !isAccountId(player.id)) {
      throw new SupportPlayerLookupError("not_found");
    }
    return {
      platform: input.platform,
      requestedNickname,
      canonicalNickname: player.attributes.name.trim(),
      accountId: player.id.trim(),
    };
  } catch (error) {
    throw lookupError(error);
  } finally {
    api.dispose();
  }
}
