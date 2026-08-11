import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type {
  Browser,
  BrowserContext,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer";
import {
  buildStatsApiRequest,
  createStatsBrowserScenario,
  createStatsQaClock,
  type StatsApiRequest,
  type StatsBrowserScenarioName,
  type StatsQaClock,
} from "../fixtures/stats/browserScenarios";

export interface StatsRequestRecord {
  id: number;
  method: string;
  url: string;
  pathname: string;
  query: Record<string, string>;
  body?: unknown;
  semanticKey: string;
  category: "stats-api" | "ad-external" | "analytics-external" | "other";
  state: "started" | "completed" | "aborted" | "unexpected";
  status?: number;
  successful: boolean;
  terminal: boolean;
  terminalSource?: "response" | "fetch-signal" | "request-failed" | "main-frame-navigation" | "interception-cancelled" | "external-block" | "ledger-abort" | "unexpected";
}

export interface StatsRequestSelector {
  pathname: string;
  method?: string;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  semanticKey?: string;
  afterRecordId?: number;
  state?: StatsRequestRecord["state"];
  successful?: boolean;
}

export interface StatsRequestLedger {
  readonly records: readonly StatsRequestRecord[];
  count(selector: StatsRequestSelector): number;
  assertNoUnexpected(): void;
  assertNoUnauthenticatedAi(): void;
  throwIfUnexpected(): void;
}

export interface StatsRequestLedgerController extends StatsRequestLedger {
  start(input: Omit<StatsRequestRecord, "id" | "state" | "successful" | "terminal">): StatsRequestRecord;
  complete(record: StatsRequestRecord, status: number, successful: boolean): void;
  abort(record: StatsRequestRecord, terminalSource?: StatsRequestRecord["terminalSource"]): void;
  unexpected(record: StatsRequestRecord, reason?: string): void;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

class RequestLedger implements StatsRequestLedgerController {
  private readonly entries: StatsRequestRecord[] = [];
  private nextId = 1;
  private unexpectedReasons: string[] = [];

  get records(): readonly StatsRequestRecord[] {
    return this.entries;
  }

  start(input: Omit<StatsRequestRecord, "id" | "state" | "successful" | "terminal">): StatsRequestRecord {
    const record: StatsRequestRecord = {
      ...input,
      id: this.nextId++,
      state: "started",
      successful: false,
      terminal: false,
    };
    this.entries.push(record);
    return record;
  }

  complete(record: StatsRequestRecord, status: number, successful: boolean): void {
    if (record.terminal) return;
    record.status = status;
    record.state = "completed";
    record.successful = successful;
    record.terminal = true;
    record.terminalSource = "response";
  }

  abort(record: StatsRequestRecord, terminalSource: StatsRequestRecord["terminalSource"] = "ledger-abort"): void {
    if (record.terminal) return;
    record.state = "aborted";
    record.successful = false;
    record.terminal = true;
    record.terminalSource = terminalSource;
  }

  unexpected(record: StatsRequestRecord, reason = "unexpected request"): void {
    if (!record.terminal) {
      record.state = "unexpected";
      record.successful = false;
      record.terminal = true;
      record.terminalSource = "unexpected";
    }
    this.unexpectedReasons.push(`${record.id}: ${reason}`);
  }

  count(selector: StatsRequestSelector): number {
    return this.entries.filter((record) => {
      if (record.pathname !== selector.pathname) return false;
      if (selector.method && record.method !== selector.method.toUpperCase()) return false;
      if (selector.afterRecordId !== undefined && record.id <= selector.afterRecordId) return false;
      if (selector.state && record.state !== selector.state) return false;
      if (selector.successful !== undefined && record.successful !== selector.successful) return false;
      if (selector.semanticKey && record.semanticKey !== selector.semanticKey) return false;
      if (selector.query && stableJson(record.query) !== stableJson(selector.query)) return false;
      if (selector.body !== undefined && stableJson(record.body) !== stableJson(selector.body)) return false;
      return true;
    }).length;
  }

  assertNoUnexpected(): void {
    const unexpected = this.entries.filter((record) => record.state === "unexpected");
    if (unexpected.length > 0 || this.unexpectedReasons.length > 0) {
      throw new Error(`Unexpected stats traffic: ${JSON.stringify({ unexpected, reasons: this.unexpectedReasons })}`);
    }
  }

  assertNoUnauthenticatedAi(): void {
    const ai = this.entries.filter((record) => [
      "/api/pubg/ai-summary",
      "/api/pubg/ai-analyze",
      "/api/pubg/ai-squad",
    ].includes(record.pathname));
    if (ai.length > 0) throw new Error(`Unauthenticated AI traffic detected: ${ai.map((record) => record.url).join(", ")}`);
  }

  throwIfUnexpected(): void {
    this.assertNoUnexpected();
    this.assertNoUnauthenticatedAi();
  }
}

export function createStatsRequestLedger(): StatsRequestLedgerController {
  return new RequestLedger();
}

export interface InstalledStatsDispatcher {
  ledger: StatsRequestLedger;
  waitForTerminal(input: { selector: StatsRequestSelector; count: number }): Promise<void>;
  withFatal<T>(condition: Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

function classifyExternal(url: URL): StatsRequestRecord["category"] {
  const value = url.toString().toLowerCase();
  if (/googlesyndication|doubleclick|googleadservices|adsbygoogle|adfit|kakao.*ad|ba\.min\.js/.test(value)) {
    return "ad-external";
  }
  if (/google-analytics|googletagmanager|analytics\.google|vercel-insights|va\.vercel-scripts|speed-insights/.test(value)) {
    return "analytics-external";
  }
  return "other";
}

function safeRequestAbort(request: HTTPRequest): void {
  if (request.isInterceptResolutionHandled()) return;
  void request.abort("blockedbyclient").catch(() => undefined);
}

function safeRequestContinue(request: HTTPRequest): void {
  if (request.isInterceptResolutionHandled()) return;
  void request.continue().catch(() => undefined);
}

function waitWithAbort(
  request: HTTPRequest,
  delayMs: number,
  failedRequests: WeakSet<HTTPRequest>,
): Promise<boolean> {
  const isInactive = () => request.isInterceptResolutionHandled() || failedRequests.has(request);
  if (delayMs <= 0) return Promise.resolve(!isInactive());
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timeout);
      clearInterval(interval);
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(!isInactive()), delayMs);
    const interval = setInterval(() => {
      if (isInactive()) finish(false);
    }, 25);
  });
}

function createRequestRecord(
  ledger: StatsRequestLedgerController,
  request: HTTPRequest,
  baseUrl: string,
  category: StatsRequestRecord["category"],
): { record: StatsRequestRecord; apiRequest?: StatsApiRequest } {
  const parsed = new URL(request.url(), baseUrl);
  const body = request.postData();
  const apiRequest = buildStatsApiRequest({
    recordId: 0,
    method: request.method(),
    url: parsed.toString(),
    body,
  });
  const record = ledger.start({
    method: apiRequest.method,
    url: apiRequest.url,
    pathname: apiRequest.pathname,
    query: { ...apiRequest.query },
    ...(apiRequest.body === undefined ? {} : { body: apiRequest.body }),
    semanticKey: apiRequest.semanticKey,
    category,
  });
  apiRequest.recordId = record.id;
  return { record, apiRequest };
}

export async function installStatsApiDispatcher(input: {
  page: Page;
  baseUrl: string;
  scenarioName: StatsBrowserScenarioName;
  clock: StatsQaClock;
}): Promise<InstalledStatsDispatcher> {
  const { page, baseUrl, scenarioName, clock } = input;
  const ledger = createStatsRequestLedger();
  const scenario = createStatsBrowserScenario({ name: scenarioName, clock });
  const requestRecords = new WeakMap<HTTPRequest, StatsRequestRecord>();
  const scenarioRequests = new WeakMap<HTTPRequest, StatsApiRequest>();
  const terminalResolvers = new WeakMap<HTTPRequest, () => void>();
  const activeStatsRequests = new Map<string, Set<HTTPRequest>>();
  const failedRequests = new WeakSet<HTTPRequest>();
  const semanticTails = new Map<string, Promise<void>>();
  const fatalState: { error: Error | null; reject?: (error: Error) => void } = { error: null };
  const fatalPromise = new Promise<never>((_, reject) => {
    fatalState.reject = reject;
  });
  void fatalPromise.catch(() => undefined);

  const triggerFatal = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (fatalState.error) return;
    fatalState.error = normalized;
    fatalState.reject?.(normalized);
  };

  const trackActiveRequest = (request: HTTPRequest): void => {
    const current = activeStatsRequests.get(request.url()) ?? new Set<HTTPRequest>();
    current.add(request);
    activeStatsRequests.set(request.url(), current);
  };

  const untrackActiveRequest = (request: HTTPRequest): void => {
    const current = activeStatsRequests.get(request.url());
    if (!current) return;
    current.delete(request);
    if (current.size === 0) activeStatsRequests.delete(request.url());
  };

  const settleTrackedRequestAsAborted = (
    request: HTTPRequest,
    terminalSource: NonNullable<StatsRequestRecord["terminalSource"]>,
  ): void => {
    const record = requestRecords.get(request);
    const apiRequest = scenarioRequests.get(request);
    if (!record || record.terminal || !apiRequest) {
      untrackActiveRequest(request);
      return;
    }
    failedRequests.add(request);
    scenario.abort(apiRequest);
    ledger.abort(record, terminalSource);
    untrackActiveRequest(request);
    terminalResolvers.get(request)?.();
    safeRequestAbort(request);
  };

  const requestHandler = (request: HTTPRequest): void => {
    const parsed = new URL(request.url(), baseUrl);
    const sameOrigin = parsed.origin === new URL(baseUrl).origin;
    const isStatsApi = sameOrigin && parsed.pathname.startsWith("/api/pubg/");

    if (!sameOrigin) {
      const record = ledger.start({
        method: request.method().toUpperCase(),
        url: request.url(),
        pathname: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams.entries()),
        semanticKey: buildStatsApiRequest({ recordId: 0, method: request.method(), url: request.url(), body: request.postData() }).semanticKey,
        category: classifyExternal(parsed),
      });
      requestRecords.set(request, record);
      ledger.abort(record, "external-block");
      safeRequestAbort(request);
      return;
    }

    if (!isStatsApi) {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        for (const active of activeStatsRequests.values()) {
          for (const previousRequest of [...active]) {
            settleTrackedRequestAsAborted(previousRequest, "main-frame-navigation");
          }
        }
      }
      safeRequestContinue(request);
      return;
    }

    const { record, apiRequest } = createRequestRecord(ledger, request, baseUrl, "stats-api");
    requestRecords.set(request, record);
    if (!apiRequest) {
      ledger.unexpected(record, "failed to build API request");
      triggerFatal(new Error("Failed to build stats API request"));
      safeRequestAbort(request);
      return;
    }
    scenarioRequests.set(request, apiRequest);
    trackActiveRequest(request);
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    terminalResolvers.set(request, resolveTerminal);
    const settleCancelledRequest = () => {
      if (record.terminal) return;
      scenario.abort(apiRequest);
      ledger.abort(record, "interception-cancelled");
      untrackActiveRequest(request);
      resolveTerminal();
    };
    const previous = semanticTails.get(apiRequest.semanticKey) ?? Promise.resolve();
    const current = previous.then(async () => {
      try {
        const active = await waitWithAbort(request, 0, failedRequests);
        if (!active || request.isInterceptResolutionHandled()) {
          settleCancelledRequest();
          return;
        }
        const response = await scenario.resolve(apiRequest);
        const ready = await waitWithAbort(request, response.delayMs ?? 0, failedRequests);
        if (!ready || request.isInterceptResolutionHandled()) {
          settleCancelledRequest();
          return;
        }
        await request.respond({
          status: response.status,
          headers: response.headers ? { ...response.headers } : { "Content-Type": "application/json" },
          body: JSON.stringify(response.body),
        });
      } catch (error) {
        ledger.unexpected(record, error instanceof Error ? error.message : String(error));
        triggerFatal(error);
        safeRequestAbort(request);
      } finally {
        await terminalPromise;
      }
    });
    semanticTails.set(apiRequest.semanticKey, current);
  };

  const responseHandler = (response: HTTPResponse): void => {
    const record = requestRecords.get(response.request());
    if (!record || record.terminal) return;
    record.status = response.status();
  };

  const requestFinishedHandler = (request: HTTPRequest): void => {
    const record = requestRecords.get(request);
    if (!record || record.terminal) return;
    ledger.complete(record, record.status ?? 0, (record.status ?? 0) >= 200 && (record.status ?? 0) < 300);
    untrackActiveRequest(request);
    terminalResolvers.get(request)?.();
  };

  const requestFailedHandler = (request: HTTPRequest): void => {
    failedRequests.add(request);
    const record = requestRecords.get(request);
    if (!record || record.terminal) return;
    const apiRequest = scenarioRequests.get(request);
    if (apiRequest) scenario.abort(apiRequest);
    ledger.abort(record, "request-failed");
    untrackActiveRequest(request);
    terminalResolvers.get(request)?.();
  };

  await page.exposeFunction("__statsHarnessNotifyFetchAbort", (url: string) => {
    const requests = [...(activeStatsRequests.get(url) ?? [])];
    for (const request of requests) settleTrackedRequestAsAborted(request, "fetch-signal");
  });
  await page.evaluateOnNewDocument(() => {
    const originalFetch = window.fetch.bind(window);
    const statsWindow = window as typeof window & {
      __statsHarnessNotifyFetchAbort?: (url: string) => Promise<void>;
    };
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const absoluteUrl = new URL(rawUrl, window.location.href).toString();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const notifyAbort = () => {
        void statsWindow.__statsHarnessNotifyFetchAbort?.(absoluteUrl);
      };
      if (signal?.aborted) notifyAbort();
      else signal?.addEventListener("abort", notifyAbort, { once: true });
      return originalFetch(input, init);
    };
  });

  await page.setRequestInterception(true);
  page.on("request", requestHandler);
  page.on("response", responseHandler);
  page.on("requestfinished", requestFinishedHandler);
  page.on("requestfailed", requestFailedHandler);

  const dispatcher: InstalledStatsDispatcher = {
    ledger,
    async waitForTerminal({ selector, count }) {
      await dispatcher.withFatal(new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 30_000;
        const poll = () => {
          try {
            ledger.throwIfUnexpected();
            if (ledger.count(selector) >= count) {
              resolve();
              return;
            }
            if (Date.now() >= deadline) {
              reject(new Error(`Timed out waiting for ${JSON.stringify(selector)} count ${count}; records=${JSON.stringify(ledger.records)}`));
              return;
            }
            setTimeout(poll, 25);
          } catch (error) {
            reject(error);
          }
        };
        poll();
      }));
      ledger.throwIfUnexpected();
    },
    async withFatal<T>(condition: Promise<T>): Promise<T> {
      if (fatalState.error) throw fatalState.error;
      const result = await Promise.race([condition, fatalPromise]);
      ledger.throwIfUnexpected();
      return result;
    },
    async dispose() {
      page.off("request", requestHandler);
      page.off("response", responseHandler);
      page.off("requestfinished", requestFinishedHandler);
      page.off("requestfailed", requestFailedHandler);
      activeStatsRequests.clear();
      try {
        await page.setRequestInterception(false);
      } catch {
        // Page may already be closing; the owned listeners are still removed above.
      }
    },
  };

  return dispatcher;
}

export async function withStatsBrowserPage<T>(input: {
  browser: Browser;
  baseUrl: string;
  scenarioName: StatsBrowserScenarioName;
  viewport: { width: number; height: number };
  clock?: StatsQaClock;
  run(context: { browserContext: BrowserContext; page: Page; dispatcher: InstalledStatsDispatcher }): Promise<T>;
}): Promise<T> {
  const browserContext = await input.browser.createBrowserContext();
  const page = await browserContext.newPage();
  await page.setViewport(input.viewport);
  const dispatcher = await installStatsApiDispatcher({
    page,
    baseUrl: input.baseUrl,
    scenarioName: input.scenarioName,
    clock: input.clock ?? createStatsQaClock(),
  });
  try {
    return await input.run({ browserContext, page, dispatcher });
  } finally {
    await dispatcher.dispose().catch(() => undefined);
    await page.close().catch(() => undefined);
    await browserContext.close().catch(() => undefined);
  }
}

export interface OwnedStatsDevServer {
  baseUrl: string;
  pid: number;
  stop(): Promise<void>;
}

async function selectUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not select an unused local port");
  return port;
}

function appendStderr(tail: string[], chunk: Buffer): void {
  tail.push(chunk.toString("utf8"));
  const joined = tail.join("");
  if (joined.length > 16_000) tail.splice(0, tail.length, joined.slice(-16_000));
}

async function waitForOwnedChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function terminateOwnedChild(child: ChildProcess, pid: number): Promise<void> {
  if (child.exitCode !== null) return;
  if (!child.killed) child.kill("SIGTERM");
  const exited = await waitForOwnedChildExit(child, 5_000);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    const killedExited = await waitForOwnedChildExit(child, 5_000);
    if (!killedExited && child.exitCode === null) {
      throw new Error(`Owned Next child ${pid} did not exit after SIGKILL`);
    }
  }
  void pid;
}

export async function startOwnedStatsDevServer(): Promise<OwnedStatsDevServer> {
  const lockPath = join(process.cwd(), ".next", "dev", "lock");
  if (existsSync(lockPath)) {
    throw new Error(`BLOCKED: existing Next dev lock cannot be safely attributed; refusing to delete ${lockPath}`);
  }
  const port = await selectUnusedPort();
  const nextBin = join(process.cwd(), "node_modules", ".bin", "next");
  const stderrTail: string[] = [];
  const child = spawn(nextBin, ["dev", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:59999",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "local-browser-qa-anon-key",
      NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT: "DAN-fixture-stats-feed-728",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (!pid) throw new Error("Next dev server did not expose a child PID");
  child.stderr?.on("data", (chunk: Buffer) => appendStderr(stderrTail, chunk));
  const baseUrl = `http://127.0.0.1:${port}`;
  let stopped = false;

  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Owned Next child exited with ${child.exitCode}\n${stderrTail.join("")}`);
      try {
        const response = await fetch(`${baseUrl}/stats`, { signal: AbortSignal.timeout(2_000) });
        const text = await response.text();
        if (response.ok && /<body[\s>]/i.test(text) && /AI 전적 검색|stats-auto-ads-boundary|__next/i.test(text)) {
          return {
            baseUrl,
            pid,
            async stop() {
              if (stopped) return;
              stopped = true;
              await terminateOwnedChild(child, pid);
            },
          };
        }
      } catch {
        // The owned child is still compiling or not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for owned Next dev server at ${baseUrl}\n${stderrTail.join("")}`);
  } catch (error) {
    if (!stopped) {
      stopped = true;
      await terminateOwnedChild(child, pid);
    }
    throw error;
  }
}

export async function waitForStatsSelector(input: {
  dispatcher: InstalledStatsDispatcher;
  page: Page;
  selector: string;
  timeoutMs?: number;
}): Promise<void> {
  await input.dispatcher.withFatal(input.page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? 30_000 }));
}

export async function waitForStatsText(input: {
  dispatcher: InstalledStatsDispatcher;
  page: Page;
  text: string;
  timeoutMs?: number;
}): Promise<void> {
  await input.dispatcher.withFatal(input.page.waitForFunction(
    (expected) => document.body?.innerText.includes(expected),
    { timeout: input.timeoutMs ?? 30_000 },
    input.text,
  ));
}

export async function gotoStatsPage(input: {
  dispatcher: InstalledStatsDispatcher;
  page: Page;
  url: string;
}): Promise<void> {
  await input.dispatcher.withFatal(input.page.goto(input.url, { waitUntil: "domcontentloaded" }));
  await waitForStatsSelector({ ...input, selector: "body" });
}
