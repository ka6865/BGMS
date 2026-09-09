import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getReview: vi.fn(),
  decideDiscordReview: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});

vi.mock("@/lib/community-agent/reviews", () => ({
  getReview: mocks.getReview,
  decideDiscordReview: mocks.decideDiscordReview,
}));

import { POST } from "@/app/api/discord/interactions/route";
import {
  buildReviewNotification,
  sendReviewNotification,
  toReviewPlainText,
  type Review,
} from "@/lib/community-agent/discord-review";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "1486900099266248825";
const CHANNEL_ID = "1486900099266248826";
const MESSAGE_ID = "1486900099266248827";
const APPLICATION_ID = "1486900099266248828";
const REVIEW_APPLICATION_ID = "1490545661702307840";
const INTERACTION_TOKEN = "i".repeat(68);
const WEBHOOK_ID = "1486900099266248829";
const WEBHOOK_TOKEN = "w".repeat(68);
const SECOND_MESSAGE_ID = "1486900099266248832";
const NOW = new Date("2026-09-09T01:00:00.000Z");

const keyPair = nacl.sign.keyPair();
const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
const reviewKeyPair = nacl.sign.keyPair();
const reviewPublicKeyHex = Buffer.from(reviewKeyPair.publicKey).toString("hex");

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: REVIEW_ID,
    kind: "post",
    status: "pending",
    title: "패치 뒤 매칭 질문",
    body: "<p>패치 이후 매칭에 관한 공개 초안입니다.</p>",
    target_post_id: null,
    target_comment_id: null,
    target_comment_content: null,
    target_comment_author: null,
    discord_message_id: MESSAGE_ID,
    result_post_id: null,
    result_comment_id: null,
    ...overrides,
  };
}

function signedRequest(
  body: Record<string, unknown>,
  timestamp = String(Math.floor(NOW.getTime() / 1_000)),
  signer = keyPair,
): Request {
  const rawBody = JSON.stringify(body);
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + rawBody), signer.secretKey)).toString("hex");
  return new Request("https://bgms.kr/api/discord/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    body: rawBody,
  });
}

function componentRequest(
  overrides: Record<string, unknown> = {},
  timestamp = String(Math.floor(NOW.getTime() / 1_000)),
  signer = keyPair,
): Request {
  return signedRequest({
    type: 3,
    application_id: APPLICATION_ID,
    token: INTERACTION_TOKEN,
    channel_id: CHANNEL_ID,
    member: { user: { id: OWNER_ID } },
    message: { id: MESSAGE_ID },
    data: { custom_id: `community:approve:${REVIEW_ID}` },
    ...overrides,
  }, timestamp, signer);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("community Discord review delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://bgms.kr");
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_CHANNEL_ID", CHANNEL_ID);
    vi.stubEnv("DISCORD_COMMUNITY_APPROVER_ID", OWNER_ID);
    mocks.after.mockReset();
    mocks.getReview.mockReset().mockResolvedValue(review());
    mocks.decideDiscordReview.mockReset().mockResolvedValue({ code: "published", postId: 77 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds bot payloads without mention parsing and keeps approval controls tied to the review UUID", () => {
    const built = buildReviewNotification(review({ body: "<p>@everyone 공개 초안</p>" }));
    expect(built.payload.allowed_mentions).toEqual({ parse: [] });
    expect(built.payload.components?.[0]).toEqual(expect.objectContaining({
      components: expect.arrayContaining([
        expect.objectContaining({ custom_id: `community:approve:${REVIEW_ID}` }),
        expect.objectContaining({ custom_id: `community:reject:${REVIEW_ID}` }),
      ]),
    }));
    expect(JSON.stringify(built.payload)).toContain("/admin/bot?tab=community&review=");
    expect(toReviewPlainText('<a href="https://example.com/source?a=1&amp;b=2">원문</a>')).toBe("원문 (https://example.com/source?a=1&b=2)");
    expect(toReviewPlainText("<a href=https://example.com/unquoted>링크</a>")).toBe("링크 (https://example.com/unquoted)");
  });

  it.each([
    ["published" as const, "발행됨", 77, null],
    ["rejected" as const, "거절됨", null, null],
  ])("sends an initial %s outbox row with status text and disabled approval controls", async (status, label, resultPostId, resultCommentId) => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "b".repeat(68));
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: status === "published" ? MESSAGE_ID : SECOND_MESSAGE_ID }));
    vi.stubGlobal("fetch", fetchImpl);

    const sent = await sendReviewNotification(review({ status, result_post_id: resultPostId, result_comment_id: resultCommentId }));
    expect(sent.messageId).toBe(status === "published" ? MESSAGE_ID : SECOND_MESSAGE_ID);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as {
      embeds: Array<{ title: string; fields: Array<{ value: string }> }>;
      components: Array<{ components: Array<Record<string, unknown>> }>;
    };
    expect(payload.embeds[0]?.title).toContain(label);
    expect(payload.components[0]?.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: `community:approve:${REVIEW_ID}`, disabled: true }),
      expect.objectContaining({ custom_id: `community:reject:${REVIEW_ID}`, disabled: true }),
    ]));
    if (status === "published") expect(JSON.stringify(payload.embeds[0]?.fields)).toContain("/board/77");
  });

  it("verifies PING with either the existing app key or the configured community app key", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_APPLICATION_ID", REVIEW_APPLICATION_ID);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_PUBLIC_KEY", reviewPublicKeyHex);

    const existingPing = await POST(signedRequest({ type: 1, application_id: APPLICATION_ID }));
    await expect(existingPing.json()).resolves.toEqual({ type: 1 });

    const reviewPing = await POST(signedRequest(
      { type: 1, application_id: REVIEW_APPLICATION_ID },
      String(Math.floor(NOW.getTime() / 1_000)),
      reviewKeyPair,
    ));
    await expect(reviewPing.json()).resolves.toEqual({ type: 1 });
  });

  it("fails closed when the configured community app has no separate verification key", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_APPLICATION_ID", REVIEW_APPLICATION_ID);

    const reviewPing = await POST(signedRequest({ type: 1, application_id: REVIEW_APPLICATION_ID }));
    expect(reviewPing.status).toBe(401);
  });

  it("rejects an existing-app component once a separate community app is configured", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_APPLICATION_ID", REVIEW_APPLICATION_ID);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_PUBLIC_KEY", reviewPublicKeyHex);
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchImpl);

    const existingComponent = await POST(componentRequest());
    await expect(existingComponent.json()).resolves.toEqual({ type: 4, data: {
      content: "유효하지 않은 Discord 상호작용입니다.", flags: 64,
    } });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.decideDiscordReview).not.toHaveBeenCalled();
  });

  it("dispatches a community component signed by the configured community app", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_APPLICATION_ID", REVIEW_APPLICATION_ID);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_PUBLIC_KEY", reviewPublicKeyHex);
    vi.stubEnv("DISCORD_BOT_TOKEN", "b".repeat(68));
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchImpl);

    const communityComponent = await POST(componentRequest(
      { application_id: REVIEW_APPLICATION_ID },
      String(Math.floor(NOW.getTime() / 1_000)),
      reviewKeyPair,
    ));
    await expect(communityComponent.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.decideDiscordReview).toHaveBeenCalledWith(REVIEW_ID, "approve", OWNER_ID, MESSAGE_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("attaches the complete plain-text draft and target comment when the embed would be too large", async () => {
    const body = `<p>${"긴 본문 ".repeat(900)}</p>`;
    const targetComment = "대상 댓글 ".repeat(200);
    const built = buildReviewNotification(review({
      body,
      target_comment_author: "댓글 작성자",
      target_comment_content: targetComment,
    }));
    expect(built.attachment).not.toBeNull();
    expect(built.attachment?.content).toContain("긴 본문");
    expect(built.attachment?.content).toContain(targetComment.trim());
    expect(built.payload.allowed_mentions).toEqual({ parse: [] });

    const fetchImpl = vi.fn().mockResolvedValue(response({ id: MESSAGE_ID }));
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("DISCORD_BOT_TOKEN", "b".repeat(68));
    const sent = await sendReviewNotification(review({ body, target_comment_content: targetComment }));
    expect(sent).toEqual({ messageId: MESSAGE_ID });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    const payload = JSON.parse(String(form.get("payload_json"))) as Record<string, unknown>;
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(await (form.get("files[0]") as Blob).text()).toContain(targetComment.trim());
  });

  it("preserves reply and target-comment newlines in the full attachment", () => {
    const replyBody = `  첫 줄\n\n둘째 줄\n${"이어지는 답글 ".repeat(500)}\n`;
    const targetComment = `  원문 첫 줄\n원문 둘째 줄\n${"댓글 ".repeat(200)}`;
    const built = buildReviewNotification(review({
      kind: "reply",
      body: replyBody,
      target_comment_content: targetComment,
    }));
    expect(built.attachment?.content).toContain(`초안 본문\n${replyBody}`);
    expect(built.attachment?.content).toContain(`원문 첫 줄\n원문 둘째 줄`);
  });

  it("uses the admin webhook fallback with wait=true and no fake component buttons", async () => {
    const publicWebhookToken = "p".repeat(68);
    vi.stubEnv("DISCORD_COMMUNITY_WEBHOOK_URL", `https://discord.com/api/webhooks/${WEBHOOK_ID}/${publicWebhookToken}`);
    vi.stubEnv("DISCORD_WEBHOOK_URL", `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_CHANNEL_ID", "");
    vi.stubEnv("DISCORD_COMMUNITY_APPROVER_ID", "");
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: MESSAGE_ID }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(sendReviewNotification(review())).resolves.toEqual({ messageId: MESSAGE_ID });
    const [url, init] = fetchImpl.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toContain("wait=true");
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.components).toBeUndefined();
    expect(JSON.stringify(payload)).toContain("/admin/bot?tab=community&review=");
    expect(String(url)).toContain(WEBHOOK_TOKEN);
    expect(String(url)).not.toContain(publicWebhookToken);
  });

  it("resolves the bot channel from review-webhook metadata only when no channel is explicit", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "b".repeat(68));
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_CHANNEL_ID", "");
    vi.stubEnv("DISCORD_COMMUNITY_REVIEW_WEBHOOK_URL", `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ channel_id: CHANNEL_ID }))
      .mockResolvedValueOnce(response({ id: MESSAGE_ID }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(sendReviewNotification(review())).resolves.toEqual({ messageId: MESSAGE_ID });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(`/api/v10/channels/${CHANNEL_ID}/messages`);
  });

  it("rejects a component from a non-owner before loading or queuing a review", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchImpl);
    const res = await POST(componentRequest({ member: { user: { id: "1486900099266248830" } } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.getReview).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.getReview).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects stale, replayed, and wrong-message components without dispatching a decision", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    const stale = await POST(componentRequest({}, String(Math.floor(NOW.getTime() / 1_000) - 301)));
    expect(stale.status).toBe(200);
    expect(mocks.getReview).not.toHaveBeenCalled();

    mocks.getReview.mockResolvedValueOnce(review({ status: "published" }));
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchImpl);
    const replay = await POST(componentRequest());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.decideDiscordReview).not.toHaveBeenCalled();

    mocks.after.mockReset();
    mocks.getReview.mockResolvedValueOnce(review({ status: "pending", discord_message_id: "1486900099266248831" }));
    const wrongMessage = await POST(componentRequest());
    expect(wrongMessage.status).toBe(200);
    await expect(wrongMessage.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.decideDiscordReview).not.toHaveBeenCalled();
  });

  it("defers an authorized component, decides after the response, and disables buttons after a terminal result", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    vi.stubEnv("DISCORD_BOT_TOKEN", "b".repeat(68));
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchImpl);
    mocks.getReview
      .mockResolvedValueOnce(review())
      .mockResolvedValueOnce(review({ status: "published" }));
    const res = await POST(componentRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.decideDiscordReview).not.toHaveBeenCalled();

    await mocks.after.mock.calls[0][0]();
    expect(mocks.decideDiscordReview).toHaveBeenCalledWith(REVIEW_ID, "approve", OWNER_ID, MESSAGE_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toContain(`/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`);
    const body = JSON.parse(String(init.body)) as { allowed_mentions: { parse: string[] }; components: Array<{ components: Array<Record<string, unknown>> }> };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components[0].components).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: `community:approve:${REVIEW_ID}`, disabled: true }),
      expect.objectContaining({ custom_id: `community:reject:${REVIEW_ID}`, disabled: true }),
    ]));
  });

  it("keeps buttons when the decision is paused or fails", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    mocks.decideDiscordReview.mockResolvedValue({ code: "paused" });
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    await POST(componentRequest());
    await mocks.after.mock.calls[0][0]();
    expect(mocks.decideDiscordReview).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    mocks.after.mockReset();
    mocks.decideDiscordReview.mockRejectedValue(new Error("storage secret should stay hidden"));
    await POST(componentRequest());
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
