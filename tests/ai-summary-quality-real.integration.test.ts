/** Explicit opt-in: current summary route + real Gemini, frozen local DB snapshot.
 * RUN_AI_SUMMARY_QUALITY_REAL=true AI_SUMMARY_QUALITY_FIXTURE=... npx vitest run tests/ai-summary-quality-real.integration.test.ts
 * The snapshot must contain rows and benchmarkRows captured with platform/player filters.
 * No remote DB/cache/usage writes are allowed; model output still needs human review.
 */
import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AI_SUMMARY_CACHE_VERSION } from '@/lib/pubg-analysis/constants';
import { hasUnsupportedSummaryInference, hasUnsupportedSummaryAdvice } from '@/lib/pubg-analysis/aiSummaryJudgment';
import { parseSummaryCards } from '@/lib/pubg-analysis/aiSummaryCards';

const audit = vi.hoisted(() => ({
  rows: [] as any[], benchmarkRows: [] as any[], calls: [] as any[], cases: [] as any[], writes: [] as any[],
  replay: [] as any[], outcomes: [] as any[], afterTasks: [] as Promise<unknown>[], writeSignals: [] as AbortSignal[],
}));
const db = vi.hoisted(() => ({ from(table: string) {
  if (!['processed_match_telemetry', 'benchmark_stats_by_tier_v2', 'player_ai_summary_cache'].includes(table)) throw new Error(`Unexpected table: ${table}`);
  const filters: Array<(row: any) => boolean> = [];
  let single = false;
  let count = Infinity;
  let writeValue: any;
  const result = () => {
    const source = table === 'processed_match_telemetry' ? audit.rows : table === 'benchmark_stats_by_tier_v2' ? audit.benchmarkRows : [];
    const rows = source.filter(row => filters.every(filter => filter(row))).slice(0, count);
    return { data: single ? rows[0] ?? null : rows, error: null };
  };
  const chain: any = {
    select: () => chain, order: () => chain,
    abortSignal: (signal: AbortSignal) => { if (!(signal instanceof AbortSignal)) throw new Error('Expected query AbortSignal'); if (writeValue) audit.writeSignals.push(signal); return chain; },
    eq: (key: string, value: any) => { filters.push(row => row[key] === value); return chain; },
    in: (key: string, values: any[]) => { filters.push(row => values.includes(row[key])); return chain; },
    limit: (value: number) => { count = value; return chain; },
    maybeSingle: () => { single = true; return chain; },
    then: (resolve: any, reject: any) => Promise.resolve(writeValue ? { data: null, error: null } : result()).then(resolve, reject),
    upsert: (value: any) => { writeValue = value; audit.writes.push({ table, value }); return chain; },
  };
  return chain;
} }));
const mockAfter = vi.hoisted(() => vi.fn((task: Promise<unknown> | (() => unknown)) => {
  const promise = typeof task === 'function' ? Promise.resolve().then(task) : Promise.resolve(task);
  audit.afterTasks.push(promise);
}));
const mockTrackAiUsage = vi.hoisted(() => vi.fn(async (userId: string, modelName: string, promptTokens: number, completionTokens: number, analysisType: string, context: any) => {
  audit.outcomes.push({ userId, modelName, promptTokens, completionTokens, analysisType, ...context });
}));
const mockTrackAiFailure = vi.hoisted(() => vi.fn(async (userId: string, analysisType: string, error: unknown, context: any) => {
  audit.outcomes.push({ userId, analysisType, error: String(error), ...context, status: 'error' });
}));
const mockPrivatePlayer = vi.hoisted(() => vi.fn(async () => null));
vi.mock('next/server', async (importOriginal) => ({ ...await importOriginal<typeof import('next/server')>(), after: mockAfter }));
vi.mock('@/utils/supabase/guard', () => ({ withAuthGuard: async () => ({ user: { id: 'local-quality-eval' }, supabaseAdmin: db }) }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => db }));
vi.mock('@/lib/pubg-analysis/aiUsageTracker', () => ({ trackAiUsage: mockTrackAiUsage, trackAiFailure: mockTrackAiFailure }));
vi.mock('@/lib/pubg/privatePlayerGuard', () => ({ blockPrivatePlayer: mockPrivatePlayer }));
vi.mock('ai', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('ai')>();
  return {
    ...sdk,
    streamText: vi.fn((options: any) => {
      if (audit.calls.length >= 6) throw new Error('Local evaluation call cap reached');
      const entry: any = { model: options.model.modelId, system: options.system, prompt: options.prompt, raw: '', usage: null, durationMs: 0 };
      audit.calls.push(entry);
      const started = Date.now();
      if (process.env.AI_SUMMARY_QUALITY_FACTS_ONLY !== 'true' && !process.env.AI_SUMMARY_QUALITY_REPLAY) {
        const result = sdk.streamText(options);
        const usage = Promise.resolve(result.usage).then((value: any) => { entry.usage = value; return value; });
        // Unselected attempts can abort before the route subscribes to usage.
        usage.catch((error: unknown) => { entry.usageError = error instanceof Error ? error.name : 'usage unavailable'; });
        return {
          ...result,
          fullStream: (async function* () {
            for await (const part of result.fullStream) {
              if (part.type === 'text-delta') entry.raw += part.text;
              if (part.type === 'finish') entry.durationMs = Date.now() - started;
              yield part;
            }
          })(),
          usage,
        };
      }
      const generation = (async () => {
        if (process.env.AI_SUMMARY_QUALITY_FACTS_ONLY === 'true') {
          const plan = JSON.parse(options.prompt.split('### [SERVER_CARD_PLAN_V2]\n')[1].split('\n### [END_SERVER_CARD_PLAN_V2]')[0]);
          entry.raw = JSON.stringify({ signature: '기록 확인', signatureSub: '관측된 기록을 확인합니다.', finalVerdict: '확인된 경기 기록을 살펴보세요.',
            debateIssues: plan.map((card: any) => ({ topicId: card.topicId, evidenceIds: card.evidenceIds, kindOpinion: '확인된 기록을 살펴보세요.', spicyOpinion: '다음 경기의 기록도 확인하세요.', reason: '이 경기 묶음의 관측 기록입니다.', evaluation: '기록을 확인하고 다음 경기와 비교하세요.', winner: null })),
            actionItems: [{ icon: 'target', title: '기록 점검', desc: '확인된 경기 기록을 살펴보세요.' }],
          });
          entry.usage = { inputTokens: 1, outputTokens: 1 };
        } else if (process.env.AI_SUMMARY_QUALITY_REPLAY) {
          const captured = audit.replay.shift();
          expect(captured?.prompt).toBe(options.prompt);
          expect(captured?.system).toBe(options.system);
          entry.raw = captured.raw;
          entry.usage = captured.usage ?? { inputTokens: 1, outputTokens: 1 };
        }
      })();
      return {
        fullStream: (async function* () {
          yield { type: 'start-step' };
          await generation;
          entry.durationMs = Date.now() - started;
          yield { type: 'text-delta', text: entry.raw };
          yield { type: 'finish-step', usage: entry.usage };
          yield { type: 'finish', finishReason: 'stop', totalUsage: entry.usage };
        })(),
        usage: generation.then(() => entry.usage),
      };
    }),
  };
});
import { POST } from '@/app/api/pubg/ai-summary/route';

const enabled = process.env.RUN_AI_SUMMARY_QUALITY_REAL === 'true';
const output = process.env.AI_SUMMARY_QUALITY_OUTPUT || 'tmp/summary-quality-eval/baseline';
let fixtureHash = '';
beforeAll(async () => {
  if (!enabled) return;
  config({ path: '.env.local', quiet: true });
  const factsOnly = process.env.AI_SUMMARY_QUALITY_FACTS_ONLY === 'true';
  if ((!process.env.GOOGLE_GEMINI_API_KEY && !factsOnly && !process.env.AI_SUMMARY_QUALITY_REPLAY) || !process.env.AI_SUMMARY_QUALITY_FIXTURE) throw new Error('Explicit fixture and Gemini key required');
  if (!process.env.GOOGLE_GEMINI_API_KEY && (factsOnly || process.env.AI_SUMMARY_QUALITY_REPLAY)) process.env.GOOGLE_GEMINI_API_KEY = 'local-provider-mock';
  const text = await readFile(process.env.AI_SUMMARY_QUALITY_FIXTURE, 'utf8');
  const fixture = JSON.parse(text);
  fixtureHash = createHash('sha256').update(text).digest('hex');
  if (process.env.AI_SUMMARY_QUALITY_REPLAY) audit.replay = JSON.parse(await readFile(process.env.AI_SUMMARY_QUALITY_REPLAY, 'utf8')).calls;
  audit.rows = fixture.rows;
  audit.benchmarkRows = fixture.benchmarkRows;
  expect(Array.isArray(audit.rows) && Array.isArray(audit.benchmarkRows)).toBe(true);
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:' || url.hostname !== 'generativelanguage.googleapis.com' || factsOnly || process.env.AI_SUMMARY_QUALITY_REPLAY) throw new Error('Network request outside live Gemini is blocked by evaluation');
    return nativeFetch(input, init);
  });
});
afterAll(async () => {
  if (!enabled) return;
  await Promise.all(audit.afterTasks);
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify({ timestamp: new Date().toISOString(), source: process.env.AI_SUMMARY_QUALITY_FACTS_ONLY === 'true' ? 'frozen-facts-with-mocked-provider' : process.env.AI_SUMMARY_QUALITY_REPLAY ? 'captured-provider-replay' : 'real-gemini', cacheVersion: AI_SUMMARY_CACHE_VERSION, fixtureHash, calls: audit.calls, cases: audit.cases, outcomes: audit.outcomes, localCacheWriteCount: audit.writes.length, remoteDatabaseWrites: 0, limitations: ['Frozen actual match results; no new telemetry ingestion in this test.', 'DB/auth/cache boundaries are mocked. Facts-only mode also mocks the provider; only real-gemini mode calls Gemini.', 'Passing structural checks is not a semantic accuracy score. Review raw and final prose against each card.'] }, null, 2));
  vi.restoreAllMocks();
});
(enabled ? describe : describe.skip)('recent maximum ten match summary quality on frozen actual records', () => {
  it('keeps the two-player fixture quality checks and captures one final outcome per response', async () => {
    const configured = process.env.AI_SUMMARY_QUALITY_PLAYERS?.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    const defaultPlayers = ['KangHeeSung_', 'MiaeQ_Q'].map(value => value.toLowerCase());
    const availablePlayers = [...new Set(audit.rows.filter(row => row.platform === 'steam').map(row => String(row.player_id).toLowerCase()))]
      .filter(player => audit.rows.filter(row => row.platform === 'steam' && String(row.player_id).toLowerCase() === player).length >= 10);
    const players = configured?.length ? configured : defaultPlayers.every(player => availablePlayers.includes(player)) ? defaultPlayers : availablePlayers.slice(0, 2);
    expect(players).toHaveLength(2);
    for (const nickname of players) {
      const rows = audit.rows.filter(row => row.platform === 'steam' && String(row.player_id).toLowerCase() === nickname);
      expect(rows.length).toBeGreaterThanOrEqual(10);
      const firstCall = audit.calls.length;
      const firstOutcome = audit.outcomes.length;
      const firstWrite = audit.writes.length;
      const firstWriteSignal = audit.writeSignals.length;
      const response = await POST(new Request('http://localhost/api/pubg/ai-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname, platform: 'steam', matchIds: rows.map(row => row.match_id), summaryContractVersion: 2, force: true }) }));
      const body = await response.text();
      const records = body.trim().split('\n').map(line => JSON.parse(line));
      const encoded = records.find(row => row.type === 'final')?.data;
      const final = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
      const facts = records.find(row => row.type === 'cards')?.data;
      const visuals = records.find(row => row.type === 'visuals')?.data;
      audit.cases.push({ nickname, status: response.status, calls: audit.calls.slice(firstCall).map((_, index) => firstCall + index), facts, visuals, final, terminal: records.filter(row => row.type === 'done' || row.type === 'error') });
      expect(response.status).toBe(200);
      expect(visuals.latestMatchCount).toBe(10);
      expect(final?.cards).toHaveLength(3);
      for (const card of facts) for (const row of card.evidence) {
        expect(Number.isInteger(row.userMatchCount)).toBe(true);
        expect(row.userMatchCount).toBeLessThanOrEqual(card.context.userMatchCount);
        if (row.userValue !== null) expect(row.userMatchCount).toBeGreaterThan(0);
      }
      expect(parseSummaryCards(final)).not.toBeNull();
      expect(final.cards.map((card: any) => card.evidence)).toEqual(facts.map((card: any) => card.evidence));
      expect(records.find(row => row.type === 'done')?.valid).toBe(true);
      const prose = [final.signature, final.signatureSub, final.finalVerdict, ...final.cards.flatMap((card: any) => [card.kindOpinion, card.spicyOpinion, card.reason, card.evaluation]), ...final.actionItems.flatMap((item: any) => [item.title, item.desc])];
      expect(prose.some(hasUnsupportedSummaryInference)).toBe(false);
      expect(prose.some(hasUnsupportedSummaryAdvice)).toBe(false);
      await Promise.all(audit.afterTasks);
      const outcomes = audit.outcomes.slice(firstOutcome);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe(records.find(row => row.type === 'done')?.partial ? 'partial' : 'success');
      expect(outcomes[0].modelName).toEqual(expect.any(String));
      expect(Number.isFinite(outcomes[0].promptTokens)).toBe(true);
      expect(Number.isFinite(outcomes[0].completionTokens)).toBe(true);
      if (outcomes[0].status === 'partial') {
        expect(outcomes[0].errorCode).toBe('validation');
        expect(outcomes[0].errorMessage).toEqual(expect.any(String));
      }
      const selectedCall = audit.calls.slice(firstCall).find((call: any) => call.model === outcomes[0].modelName);
      expect(selectedCall).toBeDefined();
      expect(outcomes[0].promptTokens).toBe(selectedCall.usage.inputTokens);
      expect(outcomes[0].completionTokens).toBe(selectedCall.usage.outputTokens);
      expect(() => JSON.parse(selectedCall.raw)).not.toThrow();
      expect(mockAfter).toHaveBeenCalledWith(expect.any(Promise));
      const shouldCache = outcomes[0].status === 'success';
      expect(audit.writes.length - firstWrite).toBe(shouldCache ? 1 : 0);
      expect(audit.writeSignals.length - firstWriteSignal).toBe(shouldCache ? 1 : 0);
      expect(mockPrivatePlayer).toHaveBeenCalled();
    }
  }, 120000);
});
