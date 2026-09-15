import { createClient } from "@supabase/supabase-js";

export interface PrivatePlayer {
  platform: string;
  nickname: string;
  lower_nickname: string;
  /** Optional stable PUBG account identity. Legacy rows do not have this field. */
  account_id?: string;
  created_at: string;
}

const SETTINGS_KEY = "private_players_list";

function getAdminClient() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/['";\s]+/g, "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").replace(/['";\s]+/g, "").trim();
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const ACCOUNT_ID_PATTERN = /^account\.[A-Za-z0-9_-]+$/;

function normalizePrivatePlayer(row: unknown): PrivatePlayer | null {
  if (!row || typeof row !== "object") return null;
  const candidate = row as Partial<PrivatePlayer>;
  const platform = typeof candidate.platform === "string" ? candidate.platform.trim().toLowerCase() : "";
  const nickname = typeof candidate.nickname === "string" ? candidate.nickname.trim() : "";
  const lowerNickname = typeof candidate.lower_nickname === "string"
    ? candidate.lower_nickname.trim().toLowerCase()
    : nickname.toLowerCase();
  if (!platform || !nickname || !lowerNickname) return null;
  return {
    platform,
    nickname,
    lower_nickname: lowerNickname,
    ...(typeof candidate.account_id === "string" && ACCOUNT_ID_PATTERN.test(candidate.account_id.trim())
      ? { account_id: candidate.account_id.trim() }
      : {}),
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : new Date(0).toISOString(),
  };
}

/**
 * 전역 설정(system_settings)에서 비공개 플레이어 목록을 조회합니다.
 */
export async function getPrivatePlayersList(): Promise<PrivatePlayer[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();

  if (error) throw error;
  if (!data?.value) return [];
  const parsed = JSON.parse(data.value);
  if (!Array.isArray(parsed)) throw new Error("Invalid private player settings");
  return parsed.map(normalizePrivatePlayer).filter((row): row is PrivatePlayer => row !== null);
}

/**
 * 특정 플랫폼/닉네임이 비공개 대상인지 확인합니다.
 */
export async function isPlayerPrivate(platform: string, nickname: string, accountId?: string): Promise<boolean> {
  if (!nickname) return false;
  const list = await getPrivatePlayersList();
  const lowerNick = nickname.trim().toLowerCase();
  const targetPlatform = platform.toLowerCase();
  const targetAccountId = typeof accountId === "string" ? accountId.trim() : "";

  return list.some(
    (p) =>
      (p.platform.toLowerCase() === targetPlatform || p.platform.toLowerCase() === "all") &&
      (p.lower_nickname === lowerNick || (targetAccountId !== "" && p.account_id === targetAccountId))
  );
}

/**
 * 비공개 플레이어를 추가합니다.
 */
export async function addPrivatePlayer(platform: string, nickname: string, accountId?: string): Promise<PrivatePlayer[]> {
  const list = await getPrivatePlayersList();
  const lowerNick = nickname.trim().toLowerCase();
  const targetPlatform = platform.toLowerCase();
  let resolvedAccountId = typeof accountId === "string" && ACCOUNT_ID_PATTERN.test(accountId.trim())
    ? accountId.trim()
    : undefined;

  // An admin normally enters only a nickname. Resolve the stable account ID
  // when the player cache already knows it, while keeping registration usable
  // for aliases and the platform-wide `all` entry.
  if (!resolvedAccountId && targetPlatform !== "all") {
    try {
      const { data } = await getAdminClient()
        .from("pubg_player_cache")
        .select("id")
        .eq("platform", targetPlatform)
        .eq("lower_nickname", lowerNick)
        .maybeSingle();
      if (typeof data?.id === "string" && ACCOUNT_ID_PATTERN.test(data.id)) resolvedAccountId = data.id;
    } catch {
      // The nickname entry is still valid when the optional cache lookup is unavailable.
    }
  }

  const existing = list.find(
    (p) => p.lower_nickname === lowerNick && p.platform.toLowerCase() === targetPlatform
  );
  let changed = false;

  if (!existing) {
    list.unshift({
      platform: targetPlatform,
      nickname: nickname.trim(),
      lower_nickname: lowerNick,
      ...(resolvedAccountId ? { account_id: resolvedAccountId } : {}),
      created_at: new Date().toISOString(),
    });
    changed = true;
  } else if (resolvedAccountId && existing.account_id !== resolvedAccountId) {
    existing.account_id = resolvedAccountId;
    changed = true;
  }

  if (changed) {
    const supabase = getAdminClient();
    const { error } = await supabase.from("system_settings").upsert({
      key: SETTINGS_KEY,
      value: JSON.stringify(list),
      description: "전적 비공개 처리된 배틀그라운드 플레이어 목록",
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  return list;
}

/**
 * 비공개 플레이어를 목록에서 제거(공개 전환)합니다.
 */
export async function removePrivatePlayer(platform: string, nickname: string): Promise<PrivatePlayer[]> {
  const list = await getPrivatePlayersList();
  const lowerNick = nickname.trim().toLowerCase();
  const targetPlatform = platform.toLowerCase();

  const updated = list.filter(
    (p) => !(p.lower_nickname === lowerNick && p.platform.toLowerCase() === targetPlatform)
  );

  const supabase = getAdminClient();
  const { error } = await supabase.from("system_settings").upsert({
    key: SETTINGS_KEY,
    value: JSON.stringify(updated),
    description: "전적 비공개 처리된 배틀그라운드 플레이어 목록",
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;

  return updated;
}
