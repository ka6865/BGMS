// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMatchAiSceneRefs,
  buildMatchAiSceneCatalog,
  findMatchAiScene,
  formatMatchAiSceneLine,
} from "@/lib/pubg-analysis/matchAiScenes";
import { applyMatchAiEvidencePolicy } from "@/lib/pubg-analysis/matchAiEvidence";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";
import { MatchAiCoachingCard } from "@/components/stat/matches/MatchAiCoachingCard";

vi.mock("@/components/common/BgmsIcon", () => ({ BgmsIcon: () => null }));
afterEach(cleanup);

const knock = { ts: 312_450, type: "KNOCK", weapon: "M416", distance: 45.4, victim: "Enemy01", isMe: true, x: 120, y: 340 };
const downed = { ts: 900_000, type: "DOWNED", weapon: "Beryl M762", isMe: true, x: 200, y: 210 };
const teamKnock = { ts: 500_000, type: "TEAM_KNOCK", isMe: false, x: 10, y: 20 };
const match = {
  timeline: [
    { ts: 60_000, type: "PHASE_START", phase: 1 },
    knock,
    { ts: 400_000, type: "KILL", x: 0, y: 0 },
    { ts: 450_000, type: "ITEM_USE", weapon: "연막탄", x: 50, y: 50 },
    teamKnock,
    downed,
  ],
};

describe("AI 코칭 장면 목록", () => {
  it("위치가 있는 교전 장면만 ID를 받고 시간순으로 정렬한다", () => {
    const catalog = buildMatchAiSceneCatalog(match);
    expect(catalog.map((scene) => scene.id)).toEqual(["KNOCK-312450", "TEAM_KNOCK-500000", "DOWNED-900000"]);
    expect(formatMatchAiSceneLine(catalog[0])).toBe("- KNOCK-312450 | 5:12 | 적 기절 (M416, 45m)");
    expect(formatMatchAiSceneLine(catalog[0])).not.toContain("Enemy01");
  });

  it("목록이 넘치면 내 장면을 먼저 남긴다", () => {
    const team = Array.from({ length: 30 }, (_, index) => ({ ts: index * 1000, type: "TEAM_KNOCK", x: 1, y: 1 }));
    const catalog = buildMatchAiSceneCatalog({ timeline: [...team, downed] });
    expect(catalog).toHaveLength(24);
    expect(catalog.map((scene) => scene.id)).toContain("DOWNED-900000");
  });

  it("내 장면이 넘쳐도 마지막 기절·사망을 남기고 팀원 장면보다 내 장면을 먼저 채운다", () => {
    const kills = Array.from({ length: 30 }, (_, index) => ({ ts: 10_000 + index * 1000, type: "KILL", x: 1, y: 1 }));
    const died = { ts: 1_200_000, type: "DIED", x: 5, y: 5 };
    const catalog = buildMatchAiSceneCatalog({ timeline: [teamKnock, ...kills, downed, died] });
    const ids = catalog.map((scene) => scene.id);
    expect(catalog).toHaveLength(24);
    expect(ids).toContain("DIED-1200000");
    expect(ids).toContain("DOWNED-900000");
    expect(ids).not.toContain("TEAM_KNOCK-500000");
    expect(ids.filter((id) => id.startsWith("KILL-"))).toEqual(kills.slice(0, 22).map((kill) => `KILL-${kill.ts}`));
    expect(catalog.map((scene) => scene.ts)).toEqual([...catalog.map((scene) => scene.ts)].sort((a, b) => a - b));
  });

  it("타임라인이 없거나 형식이 다르면 빈 목록이다", () => {
    expect(buildMatchAiSceneCatalog(null)).toEqual([]);
    expect(buildMatchAiSceneCatalog({ timeline: "broken" })).toEqual([]);
    expect(findMatchAiScene(match.timeline, "KNOCK-1")).toBeNull();
    expect(findMatchAiScene(match.timeline, 3)).toBeNull();
    expect(findMatchAiScene(match.timeline, "KNOCK-312450")?.event).toBe(knock);
  });

  it("프롬프트에 장면 목록과 ID 선택 규칙을 넣는다", () => {
    const { fullPrompt } = buildMatchAiCoachingPrompt({ matchData: { stats: {}, ...match } });
    expect(fullPrompt).toContain("[장면 목록] (장면 ID | 경과 시각 | 사건)\n- KNOCK-312450 | 5:12 | 적 기절 (M416, 45m)");
    expect(fullPrompt).toContain('"briefFeedbackSceneIds"');
    expect(fullPrompt).toContain('"sceneId"');
    expect(buildMatchAiCoachingPrompt({ matchData: { stats: {} } }).fullPrompt).toContain("[장면 목록] (장면 ID | 경과 시각 | 사건)\n없음");
  });
});

describe("AI 코칭 장면 ID 후처리", () => {
  const response = (extra: Record<string, unknown>) => JSON.stringify({
    briefFeedback: ["a", "b", "c"], finalVerdict: "v", actionItems: [{ icon: "t", title: "t", desc: "d" }], ...extra,
  });

  it("목록에 없는 ID는 지우고 briefFeedback 길이에 맞춘다", () => {
    const out = JSON.parse(applyMatchAiSceneRefs(response({
      briefFeedbackSceneIds: ["KNOCK-312450", "KILL-400000", "KNOCK-1", "DOWNED-900000"],
      actionItems: [{ icon: "t", title: "t", desc: "d", sceneId: "DOWNED-900000" }, { icon: "t", title: "t", desc: "d", sceneId: "made-up" }],
    }), match));
    expect(out.briefFeedbackSceneIds).toEqual(["KNOCK-312450", null, null]);
    expect(out.actionItems[0].sceneId).toBe("DOWNED-900000");
    expect(out.actionItems[1]).not.toHaveProperty("sceneId");
  });

  it("유효한 ID가 없거나 구버전 응답이면 장면 필드를 남기지 않는다", () => {
    expect(JSON.parse(applyMatchAiSceneRefs(response({ briefFeedbackSceneIds: [null, "x"] }), match))).not.toHaveProperty("briefFeedbackSceneIds");
    expect(JSON.parse(applyMatchAiSceneRefs(response({ briefFeedbackSceneIds: "KNOCK-312450" }), match))).not.toHaveProperty("briefFeedbackSceneIds");
    expect(JSON.parse(applyMatchAiSceneRefs(response({}), match))).toEqual(JSON.parse(response({})));
    expect(applyMatchAiSceneRefs("마크다운 응답", match)).toBe("마크다운 응답");
    expect(applyMatchAiSceneRefs("[1,2]", match)).toBe("[1,2]");
  });

  it("근거 정책을 거친 뒤에도 ID가 유지되고 재적용해도 같다", () => {
    const raw = response({ briefFeedbackSceneIds: ["KNOCK-312450", null, null] });
    const once = applyMatchAiSceneRefs(applyMatchAiEvidencePolicy(raw, match), match);
    expect(JSON.parse(once).briefFeedbackSceneIds).toEqual(["KNOCK-312450", null, null]);
    expect(applyMatchAiSceneRefs(applyMatchAiEvidencePolicy(once, match), match)).toBe(once);
  });

  it("근거 정책이 바꾼 문장과 지운 행동 제안의 장면 ID를 버리고, 인덱스가 어긋나도 남은 항목의 ID는 유지한다", () => {
    const raw = JSON.stringify({
      briefFeedback: ["무리한 진입이 문제였습니다.", "둘째 문장"],
      briefFeedbackSceneIds: ["KNOCK-312450", "DOWNED-900000"],
      finalVerdict: "v",
      actionItems: [
        { icon: "t", title: "지울 항목", desc: "무책임한 플레이였습니다.", sceneId: "KNOCK-312450" },
        { icon: "t", title: "남길 항목", desc: "팁", sceneId: "DOWNED-900000" },
        { icon: "t", title: "바뀔 항목", desc: "무리한 진입을 줄이세요.", sceneId: "KNOCK-312450" },
      ],
    });
    const finalize = (text: string) => applyMatchAiSceneRefs(applyMatchAiEvidencePolicy(text, match), match, text);
    const once = finalize(raw);
    const out = JSON.parse(once);
    expect(out.briefFeedback[0]).not.toBe("무리한 진입이 문제였습니다.");
    expect(out.briefFeedbackSceneIds).toEqual([null, "DOWNED-900000"]);
    expect(out.actionItems.map((item: { title: string }) => item.title)).toEqual(["남길 항목", "바뀔 항목"]);
    expect(out.actionItems[0].sceneId).toBe("DOWNED-900000");
    expect(out.actionItems[1]).not.toHaveProperty("sceneId");
    expect(finalize(once)).toBe(once);
    expect(finalize("마크다운 응답")).toBe(applyMatchAiEvidencePolicy("마크다운 응답", match));
    expect(JSON.parse(finalize(response({})))).not.toHaveProperty("briefFeedbackSceneIds");
  });
});

describe("AI 코칭 카드", () => {
  const card = (analysis: string, overrides: Partial<Parameters<typeof MatchAiCoachingCard>[0]> = {}) => render(createElement(MatchAiCoachingCard, {
    analysis, isAnalyzing: false, coachingStyle: "spicy", timeline: match.timeline, onSceneSelect: () => {}, ...overrides,
  }));
  const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({
    coach: "매운맛 분석가", signature: "칭호", signatureSub: "이유", briefFeedback: ["첫 문장", "둘째 문장"],
    finalVerdict: "총평", actionItems: [{ icon: "t", title: "목표", desc: "팁" }], ...extra,
  });

  it("검증된 장면에 칩을 붙이고 누르면 그 이벤트를 넘긴다", () => {
    const onSceneSelect = vi.fn();
    card(payload({ briefFeedbackSceneIds: [null, "KNOCK-312450"], actionItems: [{ icon: "t", title: "목표", desc: "팁", sceneId: "DOWNED-900000" }] }), { onSceneSelect });
    const chips = screen.getAllByRole("button", { name: /장면을 경기 흐름 지도에서 보기/ });
    expect(chips.map((chip) => chip.textContent)).toEqual(["5:12 적 기절", "15:00 내 기절"]);
    expect(chips[0]).toHaveClass("min-h-11");
    fireEvent.click(chips[0]);
    expect(onSceneSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "KNOCK-312450", event: knock }));
  });

  it("구버전 응답과 타임라인에 없는 장면은 칩 없이 그린다", () => {
    card(payload());
    expect(screen.getByText("첫 문장")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-scene-chip")).not.toBeInTheDocument();
    cleanup();
    card(payload({ briefFeedbackSceneIds: ["KNOCK-312450"] }), { timeline: [] });
    expect(screen.queryByTestId("ai-scene-chip")).not.toBeInTheDocument();
  });

  it("스트리밍 중 덜 온 JSON은 로딩, 끝난 뒤 깨진 JSON과 일반 문장은 마크다운으로 그린다", () => {
    card('{"briefFeedback": ["첫', { isAnalyzing: true });
    expect(screen.getByText("AI 전술 데이터를 수신하고 있습니다...")).toBeInTheDocument();
    cleanup();
    card('{"briefFeedback": ["첫');
    expect(screen.getByText('{"briefFeedback": ["첫')).toBeInTheDocument();
    cleanup();
    card("## 요약\n- **핵심** 문장");
    expect(screen.getByRole("heading", { name: "요약" })).toBeInTheDocument();
  });

  it("스타일별 색 클래스는 완성된 문자열로 붙는다", () => {
    const { container } = card(payload(), { coachingStyle: "mild" });
    expect(container.querySelector(".from-emerald-500\\/10")).not.toBeNull();
    cleanup();
    const spicy = card('{"x', { isAnalyzing: true });
    expect(spicy.container.querySelector(".border-t-red-500")).not.toBeNull();
  });
});
