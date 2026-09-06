import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlayerApiClient,
  PlayerApiError,
} from "@/lib/pubg/playerApiClient";

const { trackRateLimit } = vi.hoisted(() => ({
  trackRateLimit: vi.fn(),
}));

vi.mock("@/lib/pubg-analysis/pubgApiTracker", () => ({
  trackPubgRateLimit: trackRateLimit,
}));

function jsonResponse(body: string | unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asPlayerPayload(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

describe("createPlayerApiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    trackRateLimit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("passes no-store, shared signal, headers, and rate-limit headers to one validated read", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "player-1" }, 200, {
      "X-Ratelimit-Limit": "10",
      "X-Ratelimit-Remaining": "9",
      "X-Ratelimit-Reset": "1700000000",
    }));
    const parentController = new AbortController();
    const client = createPlayerApiClient({
      headers: { Authorization: "Bearer secret-token", Accept: "application/vnd.api+json" },
      signal: parentController.signal,
    });

    await expect(client.read("https://api.pubg.com/players?filter[playerNames]=HiddenNick", {
      stage: "player",
      validate: asPlayerPayload,
    })).resolves.toEqual({ id: "player-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("HiddenNick");
    expect(init).toMatchObject({
      cache: "no-store",
      headers: { Authorization: "Bearer secret-token", Accept: "application/vnd.api+json" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
    expect(trackRateLimit).toHaveBeenCalledTimes(1);
    expect(trackRateLimit.mock.calls[0][0]).toBeInstanceOf(Headers);
    client.dispose();
  });

  it.each([
    ["empty body", ""],
    ["truncated object", '{"id":"player-1"'],
  ])("recovers once from %s within the shared retry budget", async (_label, firstBody) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(firstBody))
      .mockResolvedValueOnce(jsonResponse({ id: "player-1" }));
    const client = createPlayerApiClient({
      headers: {},
      signal: new AbortController().signal,
    });

    await expect(client.read("https://api.pubg.com/players", {
      stage: "player",
      validate: asPlayerPayload,
    })).resolves.toEqual({ id: "player-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("treats complete malformed JSON and invalid shapes as terminal without retry", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"id":}'));
    const client = createPlayerApiClient({ headers: {}, signal: new AbortController().signal });

    const malformed = await client.read("https://api.pubg.com/players?token=secret", {
      stage: "player",
      validate: asPlayerPayload,
    }).catch((error) => error);
    expect(malformed).toBeInstanceOf(PlayerApiError);
    expect(malformed).toMatchObject({
      stage: "player",
      errorCode: "invalid_json",
      upstreamStatus: 200,
      responseBytes: 7,
      retryAfterSeconds: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((malformed as Error).message).not.toContain("secret");

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 123 }));
    const invalidShape = await client.read("https://api.pubg.com/players/nickname", {
      stage: "player",
      validate: asPlayerPayload,
    }).catch((error) => error);
    expect(invalidShape).toMatchObject({ errorCode: "invalid_shape", upstreamStatus: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("checks HTTP status before body parsing and never retries 404 or 429", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("not-json", 404, { "content-type": "text/plain" }));
    const client = createPlayerApiClient({ headers: {}, signal: new AbortController().signal });

    const notFound = await client.read("https://api.pubg.com/players", {
      stage: "player",
      validate: asPlayerPayload,
    }).catch((error) => error);
    expect(notFound).toMatchObject({
      errorCode: "upstream_http",
      upstreamStatus: 404,
      contentType: "text/plain",
      responseBytes: null,
      retryAfterSeconds: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse("rate limited", 429, {
      "Retry-After": "7",
      "content-type": "text/plain",
    }));
    const limited = await client.read("https://api.pubg.com/players", {
      stage: "player",
      validate: asPlayerPayload,
    }).catch((error) => error);
    expect(limited).toMatchObject({
      errorCode: "upstream_http",
      upstreamStatus: 429,
      retryAfterSeconds: 7,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("preserves Retry-After HTTP dates as seconds without retrying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fetchMock.mockResolvedValueOnce(jsonResponse("rate limited", 429, {
      "Retry-After": "Thu, 01 Jan 2026 00:00:05 GMT",
    }));
    const client = createPlayerApiClient({ headers: {}, signal: new AbortController().signal });

    const error = await client.read("https://api.pubg.com/players", {
      stage: "season",
      validate: asPlayerPayload,
    }).catch((value) => value);
    expect(error).toMatchObject({ errorCode: "upstream_http", retryAfterSeconds: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("allows only one additional retry across concurrent stages", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 3 ? jsonResponse({ id: "recovered" }) : jsonResponse("");
    });
    const client = createPlayerApiClient({ headers: {}, signal: new AbortController().signal });

    const results = await Promise.allSettled([
      client.read("https://api.pubg.com/players", { stage: "player", validate: asPlayerPayload }),
      client.read("https://api.pubg.com/seasons", { stage: "season", validate: asPlayerPayload }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : null).toMatchObject({
      errorCode: "empty_body",
    });
    client.dispose();
  });

  it("races an aborting body read and does not retry after caller abort", async () => {
    const bodyPending = new Promise<string>(() => undefined);
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn(() => bodyPending),
      body: null,
    } as unknown as Response;
    fetchMock.mockResolvedValue(response);
    const parentController = new AbortController();
    const client = createPlayerApiClient({ headers: {}, signal: parentController.signal });
    const pending = client.read("https://api.pubg.com/players", {
      stage: "player",
      validate: asPlayerPayload,
    });

    await Promise.resolve();
    parentController.abort();
    await expect(pending).rejects.toMatchObject({ errorCode: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    client.dispose();
  });

  it("aborts a pending body at the total deadline and never spends a retry", async () => {
    vi.useFakeTimers();
    const bodyPending = new Promise<string>(() => undefined);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn(() => bodyPending),
      body: null,
    } as unknown as Response);
    const client = createPlayerApiClient({
      headers: {},
      signal: new AbortController().signal,
      totalTimeoutMs: 25,
    });
    const pending = client.read("https://api.pubg.com/players", {
      stage: "player",
      timeoutMs: 1000,
      validate: asPlayerPayload,
    });
    const deadlineAssertion = expect(pending).rejects.toMatchObject({
      errorCode: "deadline_exceeded",
      stage: "player",
    });

    await vi.advanceTimersByTimeAsync(30);
    await deadlineAssertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans a per-read timeout timer after recovery and exposes timeout as retryable", async () => {
    vi.useFakeTimers();
    const firstBodyPending = new Promise<string>(() => undefined);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: vi.fn(() => firstBodyPending),
        body: null,
      } as unknown as Response)
      .mockResolvedValueOnce(jsonResponse({ id: "recovered" }));
    const client = createPlayerApiClient({ headers: {}, signal: new AbortController().signal });
    const pending = client.read("https://api.pubg.com/players", {
      stage: "player",
      timeoutMs: 10,
      validate: asPlayerPayload,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toEqual({ id: "recovered" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
