import { createClient } from "@supabase/supabase-js";

export interface PrivatePlayer {
  platform: string;
  nickname: string;
  lower_nickname: string;
  created_at: string;
}

const SETTINGS_KEY = "private_players_list";

function getAdminClient() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/['";\s]+/g, "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").replace(/['";\s]+/g, "").trim();
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * 전역 설정(system_settings)에서 비공개 플레이어 목록을 조회합니다.
 */
export async function getPrivatePlayersList(): Promise<PrivatePlayer[]> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();

    if (error || !data?.value) return [];
    const parsed = JSON.parse(data.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 특정 플랫폼/닉네임이 비공개 대상인지 확인합니다.
 */
export async function isPlayerPrivate(platform: string, nickname: string): Promise<boolean> {
  if (!nickname) return false;
  const list = await getPrivatePlayersList();
  const lowerNick = nickname.trim().toLowerCase();
  const targetPlatform = platform.toLowerCase();

  return list.some(
    (p) =>
      p.lower_nickname === lowerNick &&
      (p.platform.toLowerCase() === targetPlatform || p.platform === "all")
  );
}

/**
 * 비공개 플레이어를 추가합니다.
 */
export async function addPrivatePlayer(platform: string, nickname: string): Promise<PrivatePlayer[]> {
  const list = await getPrivatePlayersList();
  const lowerNick = nickname.trim().toLowerCase();
  const targetPlatform = platform.toLowerCase();

  const exists = list.some(
    (p) => p.lower_nickname === lowerNick && p.platform.toLowerCase() === targetPlatform
  );

  if (!exists) {
    list.unshift({
      platform: targetPlatform,
      nickname: nickname.trim(),
      lower_nickname: lowerNick,
      created_at: new Date().toISOString(),
    });

    const supabase = getAdminClient();
    await supabase.from("system_settings").upsert({
      key: SETTINGS_KEY,
      value: JSON.stringify(list),
      description: "전적 비공개 처리된 배틀그라운드 플레이어 목록",
      updated_at: new Date().toISOString(),
    });
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
  await supabase.from("system_settings").upsert({
    key: SETTINGS_KEY,
    value: JSON.stringify(updated),
    description: "전적 비공개 처리된 배틀그라운드 플레이어 목록",
    updated_at: new Date().toISOString(),
  });

  return updated;
}
