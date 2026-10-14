import { createClient } from "@supabase/supabase-js";
import { getPrivatePlayersList, matchesPrivatePlayer } from "@/lib/pubg/privatePlayers";
import { parseNicknameOption } from "../nicknameOption";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
);

const NICKNAME_OPTIONS = new Set(["nickname", "nickname1", "nickname2"]);
const MAX_CHOICES = 10;
// Discord는 자동완성 응답을 3초 안에 받아야 하므로 DB 조회만 짧게 수행한다.
const LOOKUP_TIMEOUT_MS = 1_500;

type Choice = { name: string; value: string };

function autocompleteResponse(choices: Choice[]) {
  return { type: 8, data: { choices } };
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * 닉네임 옵션 자동완성. 저장된 플레이어 캐시에서 접두어로 찾고 비공개 플레이어는 제외한다.
 * 선택값은 `플랫폼:닉네임` 형식이라 플랫폼을 따로 고르지 않아도 같은 계정을 조회한다.
 * 조회 실패는 빈 목록으로 응답하며 PUBG API는 호출하지 않는다.
 */
export async function handleNicknameAutocomplete(interaction: any) {
  const options: any[] = Array.isArray(interaction.data?.options) ? interaction.data.options : [];
  const focused = options.find((opt) => opt?.focused === true);
  if (!focused || !NICKNAME_OPTIONS.has(focused.name)) return autocompleteResponse([]);

  const typed = parseNicknameOption(focused.value);
  const query = typed.nickname.toLowerCase().slice(0, 32);
  if (query.length < 2) return autocompleteResponse([]);

  const platformOption = options.find((opt) => opt?.name === "platform");
  const platform = platformOption?.value === "steam" || platformOption?.value === "kakao"
    ? platformOption.value
    : typed.platform;

  try {
    let request = supabaseAdmin
      .from("pubg_player_cache")
      .select("id, nickname, platform")
      .like("lower_nickname", `${escapeLikePrefix(query)}%`);
    if (platform) request = request.eq("platform", platform);
    const [{ data, error }, privatePlayers] = await Promise.all([
      request.abortSignal(AbortSignal.timeout(LOOKUP_TIMEOUT_MS)).limit(MAX_CHOICES * 2),
      getPrivatePlayersList(),
    ]);
    if (error) throw error;

    const choices: Choice[] = [];
    for (const row of data || []) {
      if (typeof row.nickname !== "string" || (row.platform !== "steam" && row.platform !== "kakao")) continue;
      if (matchesPrivatePlayer(privatePlayers, row.platform, row.nickname, typeof row.id === "string" ? row.id : undefined)) continue;
      choices.push({ name: `${row.nickname} (${row.platform.toUpperCase()})`, value: `${row.platform}:${row.nickname}` });
      if (choices.length >= MAX_CHOICES) break;
    }
    return autocompleteResponse(choices);
  } catch {
    return autocompleteResponse([]);
  }
}
