import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildSquadAiCoachingPrompt } from "../lib/pubg-analysis/squadAiCoachingPrompt";
import { applySquadEvidencePolicy } from "../lib/pubg-analysis/squadAiEvidence";
import { hasSquadFeedbackContent, sanitizeSquadAbilityClaims } from "../lib/pubg-analysis/squadAiPolicy";
import { buildSquadOutputSchema } from "../lib/pubg-analysis/squadAiSchema";

// 스쿼드 페르소나(매운맛·다정한맛) 말투를 실제 Gemini로 눈으로 확인하는 도구다. 기본 단위 테스트에서는 건너뛴다.
//   npm run test:ai:squad-persona
//   SQUAD_PERSONA_MODELS=gemini-3.6-flash,gemini-3.5-flash SQUAD_PERSONA_STYLES=spicy npm run test:ai:squad-persona
// 모델은 앞에서부터 시도한다. 쿼터 초과(429)는 바로 다음 모델로, 과부하(503)는 잠시 뒤 같은 모델로 다시 한다.
// 결과는 tmp/squad-persona-preview.json 과 터미널에 남는다.
config({ path: ".env.local" });

const shouldRun = process.env.RUN_REAL_GEMINI === "true";
const describeReal = shouldRun ? describe : describe.skip;

const MODELS = (process.env.SQUAD_PERSONA_MODELS
  ?? "gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite").split(",").map(value => value.trim()).filter(Boolean);
const STYLES = (process.env.SQUAD_PERSONA_STYLES ?? "spicy,mild").split(",").map(value => value.trim()).filter(Boolean);
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 8_000;

// 실제 4인 파티(KangHeeSung_ 본인)의 비중에 개인 기록 세 가지를 모두 단 입력이다.
const ROLE_PROFILES = [
  { name: "KangHeeSung_", role: "메인 딜러", roleDesc: "주력 화력", avgDamage: 420, avgKills: 3.1, avgAssists: 1, avgDbnos: 3.4, shares: { damage: 43, kill: 36, assist: 32, dbno: 50 },
    records: { firstDeaths: { count: 4, matches: 7 }, initiative: { successes: 7, attempts: 21, matches: 7 }, farFromTeam: { count: 4, measured: 6 } } },
  { name: "ckadmfdls__", role: "서포터", roleDesc: "지원", avgDamage: 270, avgKills: 2, avgAssists: 1.8, avgDbnos: 1.6, shares: { damage: 28, kill: 26, assist: 37, dbno: 25 },
    records: { firstDeaths: { count: 1, matches: 7 }, initiative: null, farFromTeam: null } },
  { name: "MiaeQ_Q", role: "서포터", roleDesc: "지원", avgDamage: 140, avgKills: 1.6, avgAssists: 0.3, avgDbnos: 0.7, shares: { damage: 14, kill: 24, assist: 5, dbno: 10 },
    records: { firstDeaths: { count: 2, matches: 7 }, initiative: null, farFromTeam: null } },
  { name: "Suk-Cun", role: "서포터", roleDesc: "지원", avgDamage: 150, avgKills: 1.1, avgAssists: 1.2, avgDbnos: 0.9, shares: { damage: 15, kill: 16, assist: 26, dbno: 15 },
    records: { firstDeaths: { count: 0, matches: 7 }, initiative: null, farFromTeam: null } },
];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function statusOf(error: unknown): number | null {
  const match = /\[(\d{3})\s/.exec(String((error as Error)?.message ?? error));
  return match ? Number(match[1]) : null;
}

async function generate(model: string, prompt: string, systemInstruction: string) {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("RUN_REAL_GEMINI=true 실행에는 GOOGLE_GEMINI_API_KEY가 필요합니다.");
  const schema = buildSquadOutputSchema(null).jsonSchema as unknown as Record<string, unknown>;
  const generative = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model,
    systemInstruction,
    generationConfig: { responseMimeType: "application/json", temperature: 0.45 },
  });
  const suffix = `\nOutput JSON keys: ${Object.keys((schema.properties as Record<string, unknown>) ?? {}).join(", ")}. memberFeedbacks is an array of {name, praise, fault, advice}, one per member.`;
  return (await generative.generateContent(prompt + suffix)).response.text();
}

async function generateWithFallback(prompt: string, systemInstruction: string) {
  const failures: string[] = [];
  for (const model of MODELS) {
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
      try {
        return { model, text: await generate(model, prompt, systemInstruction), failures };
      } catch (error) {
        const status = statusOf(error);
        if (status === 503 && attempt < BUSY_RETRIES) { await sleep(BUSY_WAIT_MS); continue; }
        failures.push(`${model}: ${status ?? "error"}`);
        break;
      }
    }
  }
  throw new Error(`모든 모델이 실패했습니다: ${failures.join(", ")}`);
}

describeReal("실제 Gemini 스쿼드 페르소나 미리보기", () => {
  it.each(STYLES)("%s: 못한 점과 조언은 서버 문장이고 나머지 팀원은 비어 있다", async (style) => {
    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt({
      groupKey: ROLE_PROFILES.map(profile => profile.name).join(","),
      nickname: "KangHeeSung_",
      coachingStyle: style,
      squadGrade: "B",
      matchCount: 7,
      stats: { avgIsolation: null, avgTradeLatency: 9000, totalTradeKills: 12, totalTeammateKnocks: 41, totalRevives: 19, totalSmokeRescues: 3, avgCoverRate: null, totalTeamWipes: null },
      scores: { survivalCare: 77, backupSpeed: 60, smokeRescue: 30, damageBalance: 60, placement: 70 },
      benchmarkStats: { avgTradeLatency: 10400, avgReviveRate: 34.1, avgSmokeRate: 3.6, avgIsolation: null, avgTeamWipes: null, sampleCount: 900, scope: "team_population", teamMode: "squad", tier: null },
      roleProfiles: ROLE_PROFILES,
      teamMode: "squad",
    });
    const { model, text, failures } = await generateWithFallback(prompt, systemInstruction);
    const stats = { avgIsolation: null, avgTradeLatency: 9000, totalTradeKills: 12, totalTeammateKnocks: 41, totalRevives: 19, totalSmokeRescues: 3, avgCoverRate: null, totalTeamWipes: null };
    // 라우트와 같은 순서로 후처리한다. 화면에 나가는 문장을 보여준다.
    const parsed = applySquadEvidencePolicy(
      sanitizeSquadAbilityClaims(JSON.parse(text.trim().replace(/```json|```/g, "")), style),
      stats, "B", undefined, ROLE_PROFILES, { coachingStyle: style },
    ) as {
      memberFeedbacks: Array<{ name: string; praise: string; fault: string; advice: string }>;
      overallOpinion: string;
    };
    const members = parsed.memberFeedbacks.map(member => ({
      name: member.name,
      praise: member.praise,
      fault: hasSquadFeedbackContent(member.fault) ? member.fault : "",
      advice: hasSquadFeedbackContent(member.advice) ? member.advice : "",
    }));

    const outputPath = path.join(process.cwd(), "tmp", "squad-persona-preview.json");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), style, model, skippedModels: failures, members, overallOpinion: parsed.overallOpinion }, null, 2));
    process.stdout.write(`\n[${style}] model=${model}${failures.length ? ` (건너뜀: ${failures.join(", ")})` : ""}\n${JSON.stringify(members, null, 1)}\n총평: ${parsed.overallOpinion}\n`);

    for (const member of members) {
      expect(`${member.fault}${member.advice}`).not.toMatch(/(?:딜|피해량|킬|어시스트|녹다운|기절)\s*비중/u);
    }
    expect(members.filter(member => member.name !== "KangHeeSung_").every(member => member.fault === "")).toBe(true);
    expect(members.find(member => member.name === "KangHeeSung_")?.fault).not.toBe("");
  }, 300_000);
});
