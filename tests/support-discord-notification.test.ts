import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifySupportTicketCreated } from "@/lib/support/discordNotification.server";

const ticket = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "privacy" as const,
  subject: "전적 비공개 요청 @everyone",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://bgms.test");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.test/general");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("support Discord notifications", () => {
  it("sends only a compact admin alert without ticket body or attachments", async () => {
    await notifySupportTicketCreated(ticket);

    expect(fetch).toHaveBeenCalledWith("https://discord.test/general", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]).toMatchObject({
      title: "📩 새 고객센터 1:1 문의",
      url: "https://bgms.test/admin/support",
    });
    expect(body.embeds[0].fields).toEqual(expect.arrayContaining([
      { name: "문의 유형", value: "전적 비공개", inline: true },
      { name: "제목", value: ticket.subject, inline: false },
    ]));
    expect(JSON.stringify(body)).not.toContain("attachments");
    expect(JSON.stringify(body)).not.toContain("본문");
  });

  it("prefers a dedicated support webhook and skips quietly when none is configured", async () => {
    vi.stubEnv("DISCORD_SUPPORT_WEBHOOK_URL", "https://discord.test/support");
    await notifySupportTicketCreated(ticket);
    expect(fetch).toHaveBeenCalledWith("https://discord.test/support", expect.anything());

    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await notifySupportTicketCreated(ticket);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not throw when Discord is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(notifySupportTicketCreated(ticket)).resolves.toBeUndefined();
  });
});
