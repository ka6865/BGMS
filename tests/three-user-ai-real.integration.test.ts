/** Opt-in production-route evaluation: real stored inputs + real Gemini; DB/auth/cache isolated.
 * RUN_THREE_USER_AI_REAL=true npx vitest run tests/three-user-ai-real.integration.test.ts
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AI_SUMMARY_CACHE_VERSION } from '@/lib/pubg-analysis/constants';
import { parseSummaryCards } from '@/lib/pubg-analysis/aiSummaryCards';
import { collectAiCoachingQualitySignals } from '@/lib/pubg-analysis/aiCoachingQuality';
import { hasUnsupportedSummaryAdvice, hasUnsupportedSummaryInference } from '@/lib/pubg-analysis/aiSummaryJudgment';

const audit = vi.hoisted(() => ({ rows: [] as any[], benchmarks: [] as any[], calls: [] as any[], cases: [] as any[], writes: [] as any[], cache: new Map<string, any[]>(), cachePhase: false, replay: [] as any[] }));
const db = vi.hoisted(() => ({ from(table: string) {
  if (!['processed_match_telemetry','global_benchmarks','benchmark_stats_by_tier_v2','match_ai_coaching_cache','player_ai_summary_cache','squad_ai_coaching_cache'].includes(table)) throw new Error(`Unexpected DB table: ${table}`);
  const predicates: Array<(row: any) => boolean> = [];
  let single = false, limit = Infinity;
  const source = () => table === 'processed_match_telemetry' ? audit.rows : table === 'benchmark_stats_by_tier_v2' ? audit.benchmarks : audit.cache.get(table) ?? [];
  const result = () => { const rows = source().filter(row => predicates.every(test => test(row))).slice(0, limit); return { data: single ? rows.at(-1) ?? null : rows, error: null }; };
  const chain: any = {
    select: () => chain, order: () => chain, abortSignal: () => chain,
    eq: (key: string, value: any) => { predicates.push(row => row[key] === value); return chain; },
    in: (key: string, values: any[]) => { predicates.push(row => values.includes(row[key])); return chain; },
    limit: (count: number) => { limit = count; return chain; },
    maybeSingle: () => { single = true; return chain; },
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
    upsert: (value: any) => { audit.writes.push({ table, value }); audit.cache.set(table, [...audit.cache.get(table) ?? [], value]); return chain; },
  }; return chain;
} }));
vi.mock('@/utils/supabase/guard', () => ({ withAuthGuard: async () => ({ user: { id: 'local-three-user-evaluation' }, supabaseAdmin: db }) }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => db }));
vi.mock('@/lib/pubg-analysis/aiUsageTracker', () => ({ trackAiUsage: vi.fn(), trackAiFailure: vi.fn() }));
vi.mock('@google/generative-ai', async importOriginal => {
 const sdk = await importOriginal<any>();
 return { ...sdk, GoogleGenerativeAI: class extends sdk.GoogleGenerativeAI {
  getGenerativeModel(params: any, options: any) {
   const model = super.getGenerativeModel(params, options);
   const record = (prompt: any) => {
    if (audit.cachePhase) throw new Error('Cache re-read attempted a new provider call');
    if (audit.calls.length >= 45) throw new Error('Evaluation provider attempt cap reached');
    const entry = { model: params.model, system: params.systemInstruction, prompt, raw: '', usage: null as any, startedAt: Date.now(), durationMs: 0, error: null as string | null };
    audit.calls.push(entry); return entry;
   };
   return {
    async generateContent(prompt: any, opts: any) {
     const entry = record(prompt);
     if (process.env.THREE_USER_AI_REPLAY) {
      const captured = audit.replay.shift();
      expect(captured?.prompt).toEqual(prompt); expect(captured?.system).toEqual(params.systemInstruction);
      if (captured.error) throw new Error(captured.error);
      entry.raw = captured.raw;
      return { response: { text: () => captured.raw, usageMetadata: {} } };
     }
     try { const result = await model.generateContent(prompt, opts); entry.raw = result.response.text(); entry.usage = result.response.usageMetadata; return result; }
     catch (error) { entry.error = String(error); throw error; } finally { entry.durationMs = Date.now() - entry.startedAt; }
    },
    async generateContentStream(prompt: any, opts: any) {
     const entry = record(prompt);
     if (process.env.THREE_USER_AI_REPLAY) {
      const captured = audit.replay.shift();
      expect(captured?.prompt).toEqual(prompt); expect(captured?.system).toEqual(params.systemInstruction);
      if (captured.error) throw new Error(captured.error);
      entry.raw = captured.raw;
      return { stream: (async function* () { yield { text: () => captured.raw }; })(), response: Promise.resolve({ usageMetadata: {} }) };
     }
     try {
      const result = await model.generateContentStream(prompt, opts);
      const stream = (async function* () { try { for await (const chunk of result.stream) { entry.raw += chunk.text(); yield chunk; } } finally { entry.durationMs = Date.now() - entry.startedAt; } })();
      return { stream, response: result.response.then((response: any) => { entry.usage = response.usageMetadata; return response; }) };
     } catch (error) { entry.error = String(error); entry.durationMs = Date.now() - entry.startedAt; throw error; }
    },
   };
  }
 } };
});
import { POST as analyze } from '@/app/api/pubg/ai-analyze/route';
import { POST as summary } from '@/app/api/pubg/ai-summary/route';
import { POST as squad } from '@/app/api/pubg/ai-squad/route';
import { getSquadAnalysisData } from '@/lib/pubg-analysis/squadAnalysis';
const enabled = process.env.RUN_THREE_USER_AI_REAL === 'true';
const fixturePath = process.env.THREE_USER_AI_FIXTURE || 'tmp/three-user-validation/fixture.json';
const output = process.env.THREE_USER_AI_OUTPUT || 'tmp/three-user-validation/final';
const fixture = enabled ? JSON.parse(readFileSync(fixturePath, 'utf8')) : { targets: [{ nickname: 'KangHeeSung_' }, { nickname: 'MiaeQ_Q' }, { nickname: 'random-player' }] };
const request = (body: any) => new Request('http://localhost/api/pubg/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function decode(response: Response) {
 const text = await response.text();
 const records = response.headers.get('content-type')?.includes('ndjson') ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
 let final = records.length ? records.find(r => r.type === 'final')?.data ?? records.filter(r => r.type === 'chunk').map(r => r.data).join('') : JSON.parse(text);
 if (typeof final === 'string') { try { final = JSON.parse(final); } catch { /* Single coaching is prose, not a summary-card JSON contract. */ } }
 return { status: response.status, records, final };
}
beforeAll(() => {
 if (!enabled) return;
 config({ path: '.env.local', quiet: true });
 if (!process.env.GOOGLE_GEMINI_API_KEY) throw new Error('Missing Gemini key');
 audit.rows = fixture.rows; audit.benchmarks = fixture.benchmarkRows;
 if (process.env.THREE_USER_AI_REPLAY) audit.replay = JSON.parse(readFileSync(process.env.THREE_USER_AI_REPLAY, 'utf8')).calls;
 const nativeFetch = globalThis.fetch;
 vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (process.env.THREE_USER_AI_REPLAY || audit.cachePhase || url.protocol !== 'https:' || url.hostname !== 'generativelanguage.googleapis.com') throw new Error(`Non-provider network call blocked: ${url.hostname}`);
  return nativeFetch(input, init);
 });
});
afterAll(async () => {
 if (!enabled) return;
 await mkdir(output, { recursive: true });
 await writeFile(`${output}/report.json`, JSON.stringify({ timestamp: new Date().toISOString(), providerMode: process.env.THREE_USER_AI_REPLAY ? 'captured-response-replay' : 'real-gemini', cacheVersion: AI_SUMMARY_CACHE_VERSION, fixtureHash: createHash('sha256').update(readFileSync(fixturePath)).digest('hex'), capturedAt: fixture.capturedAt, selection: fixture.selection, targets: fixture.targets, calls: audit.calls, cases: audit.cases, localCacheWrites: audit.writes.length, remoteWrites: 0, limitations: ['Stored match analyses freshly read from DB; no raw telemetry recalculation or PUBG latest-history query.', 'Real production routes and Gemini; auth, DB queries, cache persistence, and usage writes isolated in memory.', 'Squad sample is same-member group selected from current eligible squad matches; may contain fewer than ten games.', 'Passing tests verifies contracts and known guards, not all natural-language semantics.'] }, null, 2));
 vi.restoreAllMocks();
});
(enabled ? describe : describe.skip)('three players: match / latest-ten summary / squad real responses', () => {
 for (const target of fixture.targets) for (const variant of ['match-mild','match-spicy','summary','squad-mild','squad-spicy']) {
  const selected = (!process.env.THREE_USER_AI_PLAYER || process.env.THREE_USER_AI_PLAYER === target.nickname) && (!process.env.THREE_USER_AI_VARIANT || process.env.THREE_USER_AI_VARIANT === variant);
  (selected ? it : it.skip)(`${target.nickname} ${variant}`, async () => {
   const isSummary = variant === 'summary', isSquad = variant.startsWith('squad');
   const route = isSummary ? summary : isSquad ? squad : analyze;
   const style = variant.endsWith('mild') ? 'mild' : 'spicy';
   let source: any;
   let body: any = { nickname: target.nickname, platform: 'steam', coachingStyle: style };
   if (isSummary) body = { ...body, matchIds: target.latestMatchIds, summaryContractVersion: 2, force: true };
   else if (isSquad) {
    const groups = await getSquadAnalysisData(target.nickname, 'steam') as any;
    expect(groups.groups?.length).toBeGreaterThan(0);
    source = await getSquadAnalysisData(target.nickname, 'steam', groups.groups[0].groupKey);
    body.groupKey = groups.groups[0].groupKey;
   } else {
    source = audit.rows.find(r => r.player_id === target.playerId && r.match_id === target.singleMatchId)?.data.fullResult;
    body.matchData = { matchId: target.singleMatchId };
   }
   const firstCall = audit.calls.length;
   const startedAt = Date.now();
   const result = await decode(await route(request(body)));
   const entry: any = { nickname: target.nickname, variant, request: body, source, ...result, durationMs: Date.now() - startedAt, callIndexes: audit.calls.slice(firstCall).map((_, i) => firstCall + i), quality: collectAiCoachingQualitySignals(typeof result.final === 'string' ? result.final : JSON.stringify(result.final)), cache: null };
   audit.cases.push(entry);
   expect(result.status).toBe(200);
   expect(result.records.some(r => r.type === 'error' || (r.type === 'done' && r.valid === false))).toBe(false);
   expect(audit.calls.slice(firstCall).some(call => call.raw.length > 0)).toBe(true);
   if (isSummary) {
    const facts = result.records.find(r => r.type === 'cards')?.data;
    expect(parseSummaryCards(result.final)).not.toBeNull();
    expect(result.final.cards).toHaveLength(3);
    expect(result.records.find(r => r.type === 'visuals')?.data.latestMatchCount).toBe(10);
    expect(result.final.cards.map((c: any) => c.evidence)).toEqual(facts.map((c: any) => c.evidence));
    const prose = [result.final.finalVerdict, ...result.final.cards.flatMap((c: any) => [c.kindOpinion,c.spicyOpinion,c.reason,c.evaluation])];
    expect(prose.some(hasUnsupportedSummaryInference)).toBe(false);
    expect(prose.some(hasUnsupportedSummaryAdvice)).toBe(false);
    for (const card of result.final.cards) for (const row of card.evidence) expect(row.userMatchCount).toBeLessThanOrEqual(card.context.userMatchCount);
   } else if (isSquad) {
    expect(result.final.squadGrade).toBeNull();
    expect(result.final.memberFeedbacks.map((m: any) => m.name).sort()).toEqual(source.roleProfiles.map((m: any) => m.name).sort());
   } else {
    expect(result.final).toEqual(expect.objectContaining({ coach: expect.any(String), signature: expect.any(String), signatureSub: expect.any(String), briefFeedback: expect.any(Array), finalVerdict: expect.any(String), actionItems: expect.any(Array) }));
   }
   audit.cachePhase = true;
   try {
    const cached = await decode(await route(request({ ...body, force: false })));
    entry.cache = cached;
    expect(cached.status).toBe(200);
    expect(cached.final).toEqual(result.final);
    expect(cached.records.some(r => r.type === 'error')).toBe(false);
   } finally { audit.cachePhase = false; }
  }, 120000);
 }
});
