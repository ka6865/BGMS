import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";

const mocks = vi.hoisted(() => ({ after: vi.fn(), link: vi.fn(), stats: vi.fn(), recent: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/discord/commands/link", () => ({ handleLinkCommand: mocks.link }));
vi.mock("@/lib/discord/commands/stats", () => ({ handleStatsCommand: mocks.stats }));
vi.mock("@/lib/discord/commands/recentMatch", () => ({ handleRecentMatchCommand: mocks.recent }));
import { POST } from "@/app/api/discord/interactions/route";

describe("discord interactions route", () => {
  const keyPair = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
  const applicationId = "1486900099266248828";
  const token = "i".repeat(68);
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    mocks.link.mockResolvedValue({ type: 4, data: { embeds: [{ title: "연동 완료" }], flags: 64 } });
    mocks.stats.mockResolvedValue({ type: 4, data: { embeds: [{ title: "저장 전적" }], components: [{ type: 1 }], flags: 64 } });
    mocks.recent.mockResolvedValue({ type: 4, data: { embeds: [{ title: "최신 저장 경기" }], flags: 64 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function createSignedRequest(body: object, timestamp = "1724112000") {
    const rawBody = JSON.stringify(body);
    const message = Buffer.from(timestamp + rawBody, "utf8");
    const signatureHex = Buffer.from(nacl.sign.detached(message, keyPair.secretKey)).toString("hex");

    return new Request("http://localhost:3000/api/discord/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": signatureHex,
        "X-Signature-Timestamp": timestamp,
      },
      body: rawBody,
    });
  }

  function commandRequest(name = "전적", overrides: Record<string, unknown> = {}) {
    return createSignedRequest({ type: 2, application_id: applicationId, token, user: { id: "1486900099266248825" }, data: { name }, ...overrides });
  }

  function editedMessage(index = 0) {
    return JSON.parse(fetchMock.mock.calls[index][1].body);
  }

  it("rejects unauthorized requests with invalid signature", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);

    const req = new Request("http://localhost:3000/api/discord/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": "invalid-signature",
        "X-Signature-Timestamp": "1724112000",
      },
      body: JSON.stringify({ type: 1 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("responds with type 1 (PONG) to type 1 (PING) requests", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);

    const req = createSignedRequest({ type: 1 });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ type: 1 });
  });

  it.each(["연동", "link", "전적", "stats", "방금판", "recent"])("defers /%s before any handler work and edits the original ephemeral response", async (name) => {
    const res = await POST(commandRequest(name));
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(mocks.recent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    const handler = ["연동", "link"].includes(name) ? mocks.link : ["전적", "stats"].includes(name) ? mocks.stats : mocks.recent;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, expect.objectContaining({ method: "PATCH", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(editedMessage()).toMatchObject({ embeds: expect.any(Array), allowed_mentions: { parse: [] } });
    expect(editedMessage()).not.toHaveProperty("flags");
    if (["전적", "stats"].includes(name)) expect(editedMessage()).toHaveProperty("components");
  });

  it("does not wait for slow privacy/database work before acknowledging the command", async () => {
    let resolve!: (value: unknown) => void;
    mocks.stats.mockReturnValue(new Promise((done) => { resolve = done; }));
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 5, data: { flags: 64 } });
    const completion = mocks.after.mock.calls[0][0]();
    expect(fetchMock).not.toHaveBeenCalled();
    resolve({ type: 4, data: { embeds: [{ title: "slow result" }] } });
    await completion;
    expect(editedMessage().embeds[0].title).toBe("slow result");
  });

  it("keeps a private-player refusal in the original ephemeral response without an embed or link", async () => {
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어의 전적은 Discord에서 제공하지 않습니다.", flags: 64 } });
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 5, data: { flags: 64 } });
    await mocks.after.mock.calls[0][0]();
    expect(editedMessage()).toEqual({ content: expect.stringContaining("비공개"), allowed_mentions: { parse: [] } });
  });

  it("hides unexpected internal handler errors", async () => {
    mocks.stats.mockRejectedValue(new Error("service role secret"));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(editedMessage().content).toContain("처리하지 못했습니다");
    expect(JSON.stringify(editedMessage())).not.toContain("secret");
  });

  it("completes a timed-out command with a visible failure and discards late results", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mocks.stats.mockReturnValue(new Promise((done) => { resolve = done; }));
    await POST(commandRequest());
    const completion = mocks.after.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(15_000);
    await completion;
    expect(editedMessage().content).toContain("시간이 초과");
    resolve({ type: 4, data: { embeds: [{ title: "late private result" }] } });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 429])("shows a safe failure for a rejected follow-up HTTP %s", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("secret Discord body", { status }));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(editedMessage(1)).toEqual({ content: expect.stringContaining("응답을 전달하지 못했습니다"), embeds: [], components: [], allowed_mentions: { parse: [] } });
    expect(console.warn).toHaveBeenCalledWith("[DiscordInteractions] 명령어 응답 갱신 실패");
  });

  it("aborts a stalled follow-up request and retries the same result once", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_, reject) => {
      signal = init.signal;
      signal.addEventListener("abort", () => reject(new Error("secret network timeout")), { once: true });
    }));
    await POST(commandRequest());
    const completion = mocks.after.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(5_000);
    await completion;
    expect(signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(editedMessage(1)).toEqual(editedMessage(0));
    expect(mocks.stats).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([500, 502, 503, 504])("retries the same result after an ambiguous follow-up HTTP %s", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("secret Discord body", { status }));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(editedMessage(1)).toEqual(editedMessage(0));
    expect(mocks.stats).toHaveBeenCalledTimes(1);
  });

  it("retries the same result after a network failure without rerunning the command", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError("secret network failure"));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(editedMessage(1)).toEqual(editedMessage(0));
    expect(mocks.stats).toHaveBeenCalledTimes(1);
  });

  it("preserves an already-applied success when its acknowledgement times out and the retry fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let visibleMessage: unknown;
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_, reject) => {
      visibleMessage = JSON.parse(init.body);
      init.signal.addEventListener("abort", () => reject(new Error("acknowledgement timeout")), { once: true });
    })).mockRejectedValueOnce(new TypeError("retry unavailable"));
    await POST(commandRequest());
    const completion = mocks.after.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(5_000);
    await completion;
    expect(visibleMessage).toMatchObject({ embeds: [{ title: "저장 전적" }] });
    expect(editedMessage(1)).toEqual(visibleMessage);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds both stalled result deliveries to five seconds each", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    }));
    await POST(commandRequest());
    const completion = mocks.after.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(10_000);
    await completion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(editedMessage(1)).toEqual(editedMessage(0));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps private-player refusals free of stats or links when retrying", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어의 전적은 Discord에서 제공하지 않습니다.", flags: 64 } });
    fetchMock.mockRejectedValueOnce(new TypeError("network failure"));
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 5, data: { flags: 64 } });
    await mocks.after.mock.calls[0][0]();
    expect(editedMessage(1)).toEqual({ content: expect.stringContaining("비공개"), allowed_mentions: { parse: [] } });
    expect(mocks.stats).toHaveBeenCalledTimes(1);
  });

  it("bounds result retries and logs no token or raw error when Discord remains unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error(`network secret ${token}`));
    await POST(commandRequest());
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[DiscordInteractions] 재시도 응답 전달 실패");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  it.each([{ token: "bad/token" }, { application_id: "../other" }, { user: { id: "invalid" } }])("rejects invalid response targets before scheduling work (%j)", async (overrides) => {
    expect(await (await POST(commandRequest("전적", overrides))).json()).toEqual({ type: 4, data: { content: expect.stringContaining("유효하지 않은"), flags: 64 } });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a safe immediate error if after cannot schedule work", async () => {
    mocks.after.mockImplementation(() => { throw new Error("runtime secret"); });
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 4, data: { content: expect.stringContaining("시작하지 못했습니다"), flags: 64 } });
  });

  it("does not schedule unsupported commands", async () => {
    expect(await (await POST(commandRequest("unsupported"))).json()).toEqual({ type: 4, data: { content: "알 수 없는 명령어입니다.", flags: 64 } });
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
