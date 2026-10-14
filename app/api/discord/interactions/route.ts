import { after, NextResponse } from "next/server";
import { verifyDiscordSignature } from "@/lib/discord/verify";
import { handleLinkCommand } from "@/lib/discord/commands/link";
import { handleStatsCommand } from "@/lib/discord/commands/stats";
import { handleRecentMatchCommand } from "@/lib/discord/commands/recentMatch";
import { decideDiscordReview, getReview, syncReviewDecisionNotification } from "@/lib/community-agent/reviews";
import {
  isDiscordInteractionToken,
  isDiscordSnowflake,
  isReviewId,
  resolveReviewChannelId,
} from "@/lib/community-agent/discord-review";

export const maxDuration = 30;

const COMPONENT_ID = /^community:(approve|reject):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_COMPONENT_AGE_SECONDS = 300;
const FOLLOWUP_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 15_000;

type ReviewDecision = "approve" | "reject";
type InteractionMessage = { content?: string; embeds?: unknown[]; components?: unknown[] };

function ephemeral(content: string): NextResponse {
  return NextResponse.json({ type: 4, data: { content, flags: 64 } });
}

function deferredEphemeral(): NextResponse {
  return NextResponse.json({ type: 5, data: { flags: 64 } });
}

function fresh(timestamp: string | null): boolean {
  if (!timestamp || !/^\d{1,20}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  return Math.abs(Math.floor(Date.now() / 1_000) - seconds) <= MAX_COMPONENT_AGE_SECONDS;
}

function componentValues(interaction: any): {
  decision: ReviewDecision;
  reviewId: string;
} | null {
  const customId = interaction?.data?.custom_id;
  if (typeof customId !== "string") return null;
  const match = customId.match(COMPONENT_ID);
  if (!match || !isReviewId(match[2])) return null;
  return { decision: match[1] as ReviewDecision, reviewId: match[2] };
}

function interactionUserId(interaction: any): string | null {
  const value = interaction?.member?.user?.id ?? interaction?.user?.id;
  return isDiscordSnowflake(value) ? value : null;
}

function configuredReviewApplicationId(): string {
  return process.env.DISCORD_COMMUNITY_REVIEW_APPLICATION_ID?.trim() || "";
}

function componentApplicationMatches(interaction: any): boolean {
  const configured = configuredReviewApplicationId();
  // An unset review application keeps the existing single-app behavior. Once
  // configured, every review component must come from that exact app; a
  // malformed setting fails closed rather than widening approval access.
  return !configured || (isDiscordSnowflake(configured) && interaction?.application_id === configured);
}

function usesReviewSignature(interaction: any): boolean {
  const configured = configuredReviewApplicationId();
  return Boolean(isDiscordSnowflake(configured)
    && (interaction?.type === 1 || interaction?.type === 3)
    && interaction?.application_id === configured);
}

function terminalDecision(code: unknown): boolean {
  return code === "published" || code === "rejected" || code === "expired" || code === "failed";
}

function terminalStatus(status: unknown): boolean {
  return status === "published" || status === "rejected" || status === "expired" || status === "failed";
}

function decisionMessage(code: unknown): string {
  switch (code) {
    case "published": return "검토 결과를 반영했습니다.";
    case "rejected": return "검토를 거절했습니다.";
    case "expired": return "이 검토는 만료되었습니다.";
    case "failed": return "검토 처리에 실패했습니다.";
    case "paused": return "현재 커뮤니티 운영이 일시 중지되어 처리하지 않았습니다.";
    case "target_changed": return "대상 내용이 바뀌어 처리하지 않았습니다.";
    case "limit": return "오늘 발행 한도에 도달해 처리하지 않았습니다.";
    case "category_disabled": return "현재 허용되지 않은 분류라 처리하지 않았습니다.";
    case "already_replied": return "이미 답글이 있어 처리하지 않았습니다.";
    default: return "검토를 완료하지 못했습니다. 잠시 후 다시 확인해 주세요.";
  }
}

async function completeInteractionResponse(interaction: any, data: InteractionMessage): Promise<void> {
  const applicationId = interaction?.application_id;
  const token = interaction?.token;
  if (!isDiscordSnowflake(applicationId) || !isDiscordInteractionToken(token)) throw new Error("invalid_interaction_response_target");
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FOLLOWUP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "PATCH",
      redirect: "error",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) throw new Error("discord_response_http", { cause: response.status });
  } finally {
    clearTimeout(timer);
  }
}

async function processReviewComponent(
  interaction: any,
  values: { decision: ReviewDecision; reviewId: string },
  userId: string,
): Promise<void> {
  let content = "검토를 완료하지 못했습니다. 잠시 후 다시 확인해 주세요.";
  try {
    const approverId = process.env.DISCORD_COMMUNITY_APPROVER_ID?.trim() || "";
    if (!isDiscordSnowflake(approverId) || userId !== approverId) {
      content = "이 검토를 처리할 권한이 없습니다.";
    } else {
      const channelId = interaction.channel_id as unknown;
      const expectedChannelId = await resolveReviewChannelId();
      if (!isDiscordSnowflake(channelId) || !expectedChannelId || channelId !== expectedChannelId) {
        content = "검토 채널이 일치하지 않습니다.";
      } else {
        const messageId = interaction.message.id as unknown;
        const review = await getReview(values.reviewId);
        if (!review || review.id !== values.reviewId) {
          content = "검토 항목을 찾을 수 없습니다.";
        } else if (!isDiscordSnowflake(messageId) || review.discord_message_id !== messageId) {
          content = "검토 메시지가 일치하지 않습니다.";
        } else if (review.status !== "pending") {
          content = "이 검토는 이미 처리되었거나 만료되었습니다.";
          if (terminalStatus(review.status)) {
            await syncReviewDecisionNotification(values.reviewId);
          }
        } else {
          const result = await decideDiscordReview(values.reviewId, values.decision, userId, messageId);
          content = decisionMessage(result?.code);
          if (terminalDecision(result?.code)) {
            await syncReviewDecisionNotification(values.reviewId);
          }
        }
      }
    }
  } catch {
    content = "검토 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  try {
    await completeInteractionResponse(interaction, { content });
  } catch {
    console.warn("[DiscordInteractions] 검토 응답 갱신 실패");
  }
}

async function processSlashCommand(interaction: any, appUrl: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let data: InteractionMessage;
  try {
    // shortcut: 시간 제한은 진행 중인 저장을 취소하지 않는다. 저장 취소가 필요해지면 DB 요청에 AbortSignal을 전달한다.
    const response = await Promise.race([
      interaction.data.name === "연동" || interaction.data.name === "link"
        ? handleLinkCommand(interaction)
        : interaction.data.name === "전적" || interaction.data.name === "stats"
          ? handleStatsCommand(interaction, appUrl)
          : handleRecentMatchCommand(interaction, appUrl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("command_timeout")), COMMAND_TIMEOUT_MS);
      }),
    ]);
    // 공개 여부는 최초 defer에서 확정하므로 PATCH에는 flags를 보내지 않는다.
    const { content, embeds, components } = response.data as InteractionMessage;
    data = { content, embeds, components };
  } catch (error) {
    data = { content: error instanceof Error && error.message === "command_timeout"
      ? "처리 시간이 초과되어 결과를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요."
      : "명령어를 처리하지 못했습니다. 플랫폼과 닉네임을 확인하고 잠시 후 다시 시도해 주세요." };
  } finally {
    clearTimeout(timer);
  }

  try {
    await completeInteractionResponse(interaction, data);
  } catch (error) {
    console.warn("[DiscordInteractions] 명령어 응답 갱신 실패");
    const status = error instanceof Error ? error.cause : null;
    // 반영 여부가 불확실한 실패는 동일 결과를 재전송해 이미 보이는 성공을 보존한다.
    const retryData = typeof status === "number" && status >= 400 && status < 500
      ? {
        content: "결과 응답을 전달하지 못했습니다. 연동 여부나 전적을 잠시 후 다시 확인해 주세요.",
        embeds: [],
        components: [],
      }
      : data;
    try {
      await completeInteractionResponse(interaction, retryData);
    } catch {
      console.warn("[DiscordInteractions] 재시도 응답 전달 실패");
    }
  }
}

async function handleReviewComponent(interaction: any, timestamp: string | null): Promise<NextResponse> {
  // Signature verification occurs in POST before this function is reached.
  if (!fresh(timestamp)) return ephemeral("이 검토 요청은 만료되었습니다.");
  const values = componentValues(interaction);
  if (!values) return ephemeral("유효하지 않은 검토 요청입니다.");
  const userId = interactionUserId(interaction);
  if (!componentApplicationMatches(interaction)
    || !userId || !isDiscordSnowflake(interaction?.channel_id) || !isDiscordSnowflake(interaction?.message?.id)
    || !isDiscordSnowflake(interaction?.application_id) || !isDiscordInteractionToken(interaction?.token)) {
    return ephemeral("유효하지 않은 Discord 상호작용입니다.");
  }

  try {
    after(() => processReviewComponent(interaction, values, userId));
  } catch {
    return ephemeral("검토 처리를 시작하지 못했습니다.");
  }
  return deferredEphemeral();
}

export async function POST(request: Request) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  const rawBody = await request.text();

  // The interaction type/application id select which public key to verify.
  // Parsing is data-only; no command, storage, or network work runs until the
  // selected Ed25519 signature has been accepted below.
  let interaction: any;
  try {
    interaction = JSON.parse(rawBody);
    if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) throw new Error("invalid_interaction_shape");
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }

  const reviewSignature = usesReviewSignature(interaction);
  const publicKey = (reviewSignature
    ? process.env.DISCORD_COMMUNITY_REVIEW_PUBLIC_KEY?.trim()
    : process.env.DISCORD_PUBLIC_KEY?.trim()) || "";

  if (!verifyDiscordSignature({ rawBody, signature, timestamp, publicKey })) {
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  // Handle Discord PING
  if (interaction.type === 1) {
    return NextResponse.json({ type: 1 });
  }

  // Handle approval/rejection button components. The callback is queued only
  // after an immediate ephemeral defer so Discord's 3-second interaction
  // deadline is never spent waiting on storage or publishing.
  if (interaction.type === 3) {
    return handleReviewComponent(interaction, timestamp);
  }

  // Handle Application Commands (Slash Commands)
  if (interaction.type === 2) {
    const commandName = interaction.data?.name;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://bgms.kr";

    if (!["연동", "link", "전적", "stats", "방금판", "recent"].includes(commandName)) {
      return ephemeral("알 수 없는 명령어입니다.");
    }
    if (!interactionUserId(interaction) || !isDiscordSnowflake(interaction.application_id)
      || !isDiscordInteractionToken(interaction.token)) {
      return ephemeral("유효하지 않은 Discord 상호작용입니다.");
    }
    try {
      after(() => processSlashCommand(interaction, appUrl));
    } catch {
      return ephemeral("명령어 처리를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    // 공개 범위 조회가 끝나기 전에도 호출자에게만 응답하며 비공개 전적은 제공하지 않는다.
    return deferredEphemeral();
  }

  return NextResponse.json({ type: 4, data: { content: "지원하지 않는 상호작용 유형입니다.", flags: 64 } });
}
