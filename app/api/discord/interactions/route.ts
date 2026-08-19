import { NextResponse } from "next/server";
import { verifyDiscordSignature } from "@/lib/discord/verify";
import { handleLinkCommand } from "@/lib/discord/commands/link";
import { handleStatsCommand } from "@/lib/discord/commands/stats";
import { handleRecentMatchCommand } from "@/lib/discord/commands/recentMatch";

export const maxDuration = 15;

export async function POST(request: Request) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim() || "";

  const rawBody = await request.text();

  if (!verifyDiscordSignature({ rawBody, signature, timestamp, publicKey })) {
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  let interaction: any;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }

  // Handle Discord PING
  if (interaction.type === 1) {
    return NextResponse.json({ type: 1 });
  }

  // Handle Application Commands (Slash Commands)
  if (interaction.type === 2) {
    const commandName = interaction.data?.name;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://bgms.kr";

    try {
      if (commandName === "연동" || commandName === "link") {
        const response = await handleLinkCommand(interaction);
        return NextResponse.json(response);
      }

      if (commandName === "전적" || commandName === "stats") {
        const response = await handleStatsCommand(interaction, appUrl);
        return NextResponse.json(response);
      }

      if (commandName === "방금판" || commandName === "recent") {
        const response = await handleRecentMatchCommand(interaction, appUrl);
        return NextResponse.json(response);
      }

      return NextResponse.json({
        type: 4,
        data: { content: "알 수 없는 명령어입니다.", flags: 64 },
      });
    } catch (err: any) {
      console.error("[DiscordInteractions] Command handler error:", err);
      return NextResponse.json({
        type: 4,
        data: { content: `명령어 처리 중 오류가 발생했습니다: ${err?.message || err}`, flags: 64 },
      });
    }
  }

  return NextResponse.json({ type: 4, data: { content: "지원하지 않는 상호작용 유형입니다.", flags: 64 } });
}

