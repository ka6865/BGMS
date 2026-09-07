import { afterEach, describe, expect, it, vi } from "vitest";
import { createSquadRequestCache } from "@/lib/stats/squadRequestCache";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("page-scoped squad request cache", () => {
  it("shares pending requests and reuses success for one minute", async () => {
    vi.useFakeTimers();
    let resolve!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
    vi.stubGlobal("fetch", fetcher);
    const cache = createSquadRequestCache();
    const a = cache.get("user", "/groups");
    const b = cache.get("user", "/groups");
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(Response.json({ groups: [] }));
    expect(await a).toEqual(await b);
    await cache.get("user", "/groups");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    fetcher.mockImplementation(() => Promise.resolve(Response.json({ groups: [1] })));
    expect(await cache.get("user", "/groups")).toEqual({ groups: [1] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("isolates page and auth scopes and does not retain failures", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 503 }))
      .mockImplementation(() => Promise.resolve(Response.json({ groups: [] })));
    vi.stubGlobal("fetch", fetcher);
    const cache = createSquadRequestCache();
    await expect(cache.get("one", "/groups")).rejects.toThrow();
    await cache.get("one", "/groups");
    await cache.get("two", "/groups");
    await createSquadRequestCache().get("one", "/groups");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("does not cache malformed success and aborts stalled GETs", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ unexpected: true }))
      .mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    vi.stubGlobal("fetch", fetcher);
    const cache = createSquadRequestCache();
    await expect(cache.get("user", "/groups")).rejects.toThrow("형식 오류");
    const timeout = expect(cache.get("user", "/groups")).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(20_001);
    await timeout;
    fetcher.mockImplementation(() => Promise.resolve(Response.json({ groups: [] })));
    await cache.get("user", "/groups");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reuses a known calculation wait across tab revisits and checks again after expiry", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({errorCode:"PUBG_CALCULATION_UPGRADE_REQUIRED",retryable:false},{status:409}))
      .mockImplementation(() => Promise.resolve(Response.json({groups:[]})));
    vi.stubGlobal("fetch", fetcher);
    const cache = createSquadRequestCache();
    await expect(cache.get("user", "/groups")).rejects.toMatchObject({status:409});
    await expect(cache.get("user", "/groups")).rejects.toMatchObject({status:409});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(cache.get("user", "/groups")).resolves.toEqual({groups:[]});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

});
