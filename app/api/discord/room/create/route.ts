import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CATEGORY_ID = process.env.DISCORD_CATEGORY_ID;

const ROOM_TYPES = ["duo", "squad"] as const;
type RoomType = (typeof ROOM_TYPES)[number];

const AUTHOR_MAX_LENGTH = 24;

function isRoomType(value: unknown): value is RoomType {
  return typeof value === "string" && (ROOM_TYPES as readonly string[]).includes(value);
}

/**
 * 채널 이름에 들어갈 표시명을 정리합니다.
 * 요청 본문의 값을 그대로 쓰면 Discord 채널 목록을 임의 문자열로 오염시킬 수 있습니다.
 */
function normalizeAuthor(value: unknown): string {
  if (typeof value !== "string") return "익명";
  const cleaned = value
    .normalize("NFC")
    // 제어문자, Discord 마크다운/멘션 트리거 제거

    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[@#`*_~|\\<>]/g, "")
    .trim()
    .slice(0, AUTHOR_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : "익명";
}

/**
 * @fileoverview 디스코드 음성 채널을 동적으로 생성하고 초대장을 발급하는 API입니다.
 * 봇 토큰으로 실제 길드에 채널을 만들기 때문에 다음을 강제합니다.
 *   1. 로그인 필수 (withAuthGuard)
 *   2. DB 기반 쿼터: 사용자당 1시간 3개, 전체 1시간 20개
 *   3. 입력 화이트리스트: type 은 duo|squad, 표시명은 길이·문자 제한
 */
export async function POST(req: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) {
      return NextResponse.json(
        { error: "디스코드 팀 채널 생성은 로그인 후 이용할 수 있습니다." },
        { status: 401 }
      );
    }
    const { user, supabaseAdmin } = auth;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
    }

    const { type, author } = (body ?? {}) as { type?: unknown; author?: unknown };
    if (!isRoomType(type)) {
      return NextResponse.json(
        { error: "채널 종류는 duo 또는 squad 만 지원합니다." },
        { status: 400 }
      );
    }

    const safeAuthor = normalizeAuthor(author);
    const userLimit = type === "duo" ? 2 : 4;

    if (!BOT_TOKEN || !GUILD_ID) {
      return NextResponse.json(
        { error: "서버의 디스코드 설정(TOKEN, GUILD_ID)이 올바르지 않습니다." },
        { status: 500 }
      );
    }

    const { data: quotaAllowed, error: quotaError } = await supabaseAdmin.rpc(
      "consume_discord_room_quota",
      { p_user_id: user.id }
    );

    if (quotaError) {
      console.error("❌ [Discord Room Quota Error]:", quotaError.message);
      return NextResponse.json(
        { error: "채널 생성 쿼터를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." },
        { status: 503 }
      );
    }
    if (quotaAllowed !== true) {
      return NextResponse.json(
        { error: "채널 생성 한도를 초과했습니다. 1시간 후 다시 시도해 주세요." },
        { status: 429 }
      );
    }

    console.log(`🌐 [Discord Room Creation]: ${type} room requested by user ${user.id}`);

    // 1. 디스코드 음성 채널 생성 요청
    const parentId = CATEGORY_ID?.trim() || undefined;

    const createRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `🔊 [${type.toUpperCase()}] ${safeAuthor}님의 팀`,
        type: 2, // Voice Channel
        user_limit: userLimit,
        parent_id: parentId && parentId.length > 5 ? parentId : undefined,
      }),
    });

    const channel = await createRes.json();
    if (!createRes.ok) {
      console.error("❌ [Discord Channel Create Failed]:", channel);
      throw new Error(channel.message || "채널 생성 중 오류가 발생했습니다.");
    }

    // 2. 생성된 채널의 초대 링크 발급 (만료 없음, 무제한)
    const inviteRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_age: 0,
        max_uses: 0,
        unique: true,
      }),
    });

    const invite = await inviteRes.json();
    if (!inviteRes.ok) {
      console.error("❌ [Discord Invite Create Failed]:", invite);
      throw new Error(invite.message || "초대 링크 생성 중 오류가 발생했습니다.");
    }

    console.log(`✅ [Discord Room Ready]: Channel ID ${channel.id}`);

    return NextResponse.json({
      success: true,
      channelId: channel.id,
      inviteUrl: `https://discord.gg/${invite.code}`,
    });

  } catch (err: unknown) {
    console.error("🚨 [Discord API Critical Error]:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "디스코드 연동 중 서버 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
