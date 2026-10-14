import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), link: vi.fn(), unlink: vi.fn(), stats: vi.fn(), recent: vi.fn(), compare: vi.fn(), userStats: vi.fn(), autocomplete: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/discord/commands/link", () => ({ handleLinkCommand: mocks.link, handleUnlinkCommand: mocks.unlink }));
vi.mock("@/lib/discord/commands/stats", () => ({ handleStatsCommand: mocks.stats }));
vi.mock("@/lib/discord/commands/recentMatch", () => ({ handleRecentMatchCommand: mocks.recent }));
vi.mock("@/lib/discord/commands/compare", () => ({ handleCompareCommand: mocks.compare }));
vi.mock("@/lib/discord/commands/userStats", () => ({ handleUserStatsCommand: mocks.userStats, USER_STATS_COMMAND_NAME: "전적 보기" }));
vi.mock("@/lib/discord/commands/autocomplete", () => ({ handleNicknameAutocomplete: mocks.autocomplete }));
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
    mocks.unlink.mockResolvedValue({ type: 4, data: { content: "연동을 해제했습니다.", flags: 64 } });
    mocks.stats.mockResolvedValue({ type: 4, data: { embeds: [{ title: "저장 전적" }], components: [{ type: 1 }], flags: 0 } });
    mocks.recent.mockResolvedValue({ type: 4, data: { embeds: [{ title: "최신 저장 경기" }], flags: 0 } });
    mocks.compare.mockResolvedValue({ type: 4, data: { embeds: [{ title: "비교" }], components: [{ type: 1 }], flags: 0 } });
    mocks.userStats.mockResolvedValue({ type: 4, data: { embeds: [{ title: "우클릭 전적" }], flags: 0 } });
    mocks.autocomplete.mockResolvedValue({ type: 8, data: { choices: [{ name: "Player (STEAM)", value: "steam:Player" }] } });
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

  function privateMessage() {
    const call = fetchMock.mock.calls.find(([, init]) => init.method === "POST");
    return call ? JSON.parse(call[1].body) : null;
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

  it.each(["전적", "stats", "방금판", "recent"])("defers /%s before any handler work and edits the original public response", async (name) => {
    const res = await POST(commandRequest(name));
    expect(await res.json()).toEqual({ type: 5, data: {} });
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(mocks.recent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    const handler = ["전적", "stats"].includes(name) ? mocks.stats : mocks.recent;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, expect.objectContaining({ method: "PATCH", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(editedMessage()).toMatchObject({ embeds: expect.any(Array), allowed_mentions: { parse: [] } });
    expect(editedMessage()).not.toHaveProperty("flags");
    if (["전적", "stats"].includes(name)) expect(editedMessage()).toHaveProperty("components");
  });

  it.each(["연동", "link"])("defers /%s privately and edits only the ephemeral original", async (name) => {
    const res = await POST(commandRequest(name));
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.link).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, expect.objectContaining({ method: "PATCH" }));
    expect(editedMessage()).toEqual({ embeds: [{ title: "연동 완료" }], allowed_mentions: { parse: [] } });
  });

  it.each(["연동해제", "unlink"])("defers /%s privately and edits only the ephemeral original", async (name) => {
    expect(await (await POST(commandRequest(name))).json()).toEqual({ type: 5, data: { flags: 64 } });
    await mocks.after.mock.calls[0][0]();
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.link).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH"]);
    expect(editedMessage()).toEqual({ content: "연동을 해제했습니다.", allowed_mentions: { parse: [] } });
  });

  it("keeps link failures on the ephemeral original without a placeholder or follow-up", async () => {
    mocks.link.mockResolvedValue({ type: 4, data: { content: "계정을 연동하지 못했습니다.", flags: 64 } });
    await POST(commandRequest("연동"));
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH"]);
    expect(editedMessage()).toEqual({ content: "계정을 연동하지 못했습니다.", allowed_mentions: { parse: [] } });
  });

  it("replaces a rejected link result on the ephemeral original with a safe failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("secret Discord body", { status: 400 }));
    await POST(commandRequest("연동"));
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH", "PATCH"]);
    expect(editedMessage(1)).toEqual({ content: expect.stringContaining("응답을 전달하지 못했습니다"), embeds: [], components: [], allowed_mentions: { parse: [] } });
  });

  it.each(["비교", "compare"])("defers /%s publicly and edits the original with the comparison", async (name) => {
    expect(await (await POST(commandRequest(name))).json()).toEqual({ type: 5, data: {} });
    await mocks.after.mock.calls[0][0]();
    expect(mocks.compare).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH"]);
    expect(editedMessage()).toEqual({ embeds: [{ title: "비교" }], components: [{ type: 1 }], allowed_mentions: { parse: [] } });
  });

  it("defers the user context menu publicly like /전적 and edits the original with the result", async () => {
    const res = await POST(commandRequest("전적 보기", { data: { type: 2, name: "전적 보기", target_id: "1486900099266248826" } }));
    expect(await res.json()).toEqual({ type: 5, data: {} });
    await mocks.after.mock.calls[0][0]();
    expect(mocks.userStats).toHaveBeenCalledTimes(1);
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH"]);
    expect(editedMessage()).toEqual({ embeds: [{ title: "우클릭 전적" }], allowed_mentions: { parse: [] } });
  });

  it("keeps the context menu's unlinked-target notice private", async () => {
    mocks.userStats.mockResolvedValue({ type: 4, data: { content: "이 사용자는 배틀그라운드 계정을 연동하지 않았습니다.", flags: 64 } });
    await POST(commandRequest("전적 보기", { data: { type: 2, name: "전적 보기", target_id: "1486900099266248826" } }));
    await mocks.after.mock.calls[0][0]();
    expect(editedMessage()).toEqual({ content: "처리를 마쳤습니다.", allowed_mentions: { parse: [] } });
    expect(privateMessage()).toMatchObject({ content: expect.stringContaining("연동하지 않았습니다"), flags: 64 });
  });

  it("does not accept the context menu name as a slash command or slash names as user commands", async () => {
    expect(await (await POST(commandRequest("전적 보기"))).json()).toEqual({ type: 4, data: { content: "알 수 없는 명령어입니다.", flags: 64 } });
    expect(await (await POST(commandRequest("전적", { data: { type: 2, name: "전적" } }))).json()).toEqual({ type: 4, data: { content: "알 수 없는 명령어입니다.", flags: 64 } });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("answers nickname autocomplete synchronously without deferring", async () => {
    const res = await POST(createSignedRequest({ type: 4, application_id: applicationId, data: { name: "전적", options: [{ name: "nickname", value: "pl", focused: true }] } }));
    expect(await res.json()).toEqual({ type: 8, data: { choices: [{ name: "Player (STEAM)", value: "steam:Player" }] } });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty autocomplete choices for unknown commands", async () => {
    const res = await POST(createSignedRequest({ type: 4, application_id: applicationId, data: { name: "other", options: [] } }));
    expect(await res.json()).toEqual({ type: 8, data: { choices: [] } });
    expect(mocks.autocomplete).not.toHaveBeenCalled();
  });

  it("does not wait for slow privacy/database work before acknowledging the command", async () => {
    let resolve!: (value: unknown) => void;
    mocks.stats.mockReturnValue(new Promise((done) => { resolve = done; }));
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 5, data: {} });
    const completion = mocks.after.mock.calls[0][0]();
    expect(fetchMock).not.toHaveBeenCalled();
    resolve({ type: 4, data: { embeds: [{ title: "slow result" }], flags: 0 } });
    await completion;
    expect(editedMessage().embeds[0].title).toBe("slow result");
  });

  it("keeps private-player refusals out of public responses and removes the public placeholder", async () => {
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어의 전적은 Discord에서 제공하지 않습니다.", flags: 64 } });
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 5, data: {} });
    await mocks.after.mock.calls[0][0]();
    expect(editedMessage()).toEqual({ content: "처리를 마쳤습니다.", allowed_mentions: { parse: [] } });
    expect(privateMessage()).toEqual({ content: expect.stringContaining("비공개"), flags: 64, allowed_mentions: { parse: [] } });
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH", "POST", "DELETE"]);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`);
    expect(fetchMock.mock.calls[2][0]).toBe(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`);
    expect(fetchMock.mock.calls[2][1].body).toBeUndefined();
  });

  it("waits for the public original to finish before posting an ephemeral follow-up", async () => {
    let resolve!: (value: Response) => void;
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어", flags: 64 } });
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await POST(commandRequest());
    const completion = mocks.after.mock.calls[0][0]();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(privateMessage()).toBeNull();
    resolve(new Response("{}", { status: 200 }));
    await completion;
    expect(privateMessage()).toMatchObject({ content: "비공개 플레이어", flags: 64 });
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH", "POST", "DELETE"]);
  });

  it("still removes the public placeholder when private delivery fails and does not retry message creation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어", flags: 64 } });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockRejectedValueOnce(new Error("private delivery secret"));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PATCH", "POST", "DELETE"]);
    expect(warn).toHaveBeenCalledWith("[DiscordInteractions] 비공개 안내 전달 실패");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("keeps the refusal private when deleting the public placeholder fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어", flags: 64 } });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("secret Discord body", { status: 500 }));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(privateMessage()).toMatchObject({ content: "비공개 플레이어", flags: 64 });
    expect(editedMessage()).toEqual({ content: "처리를 마쳤습니다.", allowed_mentions: { parse: [] } });
    expect(warn).toHaveBeenCalledWith("[DiscordInteractions] 공개 처리 표시 삭제 실패");
  });

  it("fails closed when a handler omits its public-success flag", async () => {
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "알 수 없는 상태" } });
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(privateMessage()).toMatchObject({ content: "알 수 없는 상태", flags: 64 });
    expect(editedMessage().content).toBe("처리를 마쳤습니다.");
  });

  it("hides unexpected internal handler errors", async () => {
    mocks.stats.mockRejectedValue(new Error("service role secret"));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(privateMessage().content).toContain("처리하지 못했습니다");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret");
  });

  it("completes a timed-out command with a visible failure and discards late results", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mocks.stats.mockReturnValue(new Promise((done) => { resolve = done; }));
    await POST(commandRequest());
    const completion = mocks.after.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(15_000);
    await completion;
    expect(privateMessage()).toMatchObject({ content: expect.stringContaining("시간이 초과"), flags: 64 });
    resolve({ type: 4, data: { embeds: [{ title: "late private result" }] } });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 429])("shows a safe failure for a rejected follow-up HTTP %s", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("secret Discord body", { status }));
    await POST(commandRequest());
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(editedMessage(1)).toEqual({ content: "처리를 마쳤습니다.", allowed_mentions: { parse: [] } });
    expect(privateMessage()).toEqual({ content: expect.stringContaining("응답을 전달하지 못했습니다"), flags: 64, allowed_mentions: { parse: [] } });
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

  it("fails closed if the public placeholder cannot be completed before a private refusal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.stats.mockResolvedValue({ type: 4, data: { content: "비공개 플레이어의 전적은 Discord에서 제공하지 않습니다.", flags: 64 } });
    fetchMock.mockRejectedValueOnce(new TypeError("network failure"));
    expect(await (await POST(commandRequest())).json()).toEqual({ type: 5, data: {} });
    await mocks.after.mock.calls[0][0]();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(editedMessage()).toEqual({ content: "처리를 마쳤습니다.", allowed_mentions: { parse: [] } });
    expect(privateMessage()).toBeNull();
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
