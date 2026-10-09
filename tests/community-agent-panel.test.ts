// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../components/admin/CommunityReviewQueue", () => ({
  default: () => React.createElement("section", { "aria-label": "게시글·답글 승인 대기" }),
}));
import CommunityAgentPanel from "../components/admin/CommunityAgentPanel";
import type { CommunityAgentStatus, RunSnapshot, Stage } from "../lib/community-agent/types";

function status(overrides: Partial<CommunityAgentStatus> = {}): CommunityAgentStatus {
  return {
    generatedAt: "2026-09-09T00:00:00.000Z",
    policy: {
      enabled: true,
      publishingEnabled: false,
      botUserId: "11111111-1111-4111-8111-111111111111",
      categories: ["배그 소식", "자유"],
      dailyPostLimit: 1,
      sourceEnabled: { dc: true, naver: true, youtube: false },
    },
    sources: [
      { id: "dc", state: "ok", reason: null, lastSuccessAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", channel: null },
      { id: "naver", state: "needs_setup", reason: "missing_credentials", lastSuccessAt: null, updatedAt: "2026-09-09T00:00:00.000Z", channel: null },
      { id: "youtube", state: "disabled", reason: null, lastSuccessAt: null, updatedAt: "2026-09-09T00:00:00.000Z", channel: null },
    ],
    runs: [],
    usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    missingEnv: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222", day: "2026-10-07", status: "collecting",
    stages: {}, modelCalls: 0, reports: [], topic: null, draft: null, validation: null,
    dryRun: true, postId: null, reason: null, ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunityAgentPanel", () => {
  it("조회 실패를 정상 0건으로 보여주지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    render(React.createElement(CommunityAgentPanel));

    expect(await screen.findByRole("alert")).toHaveTextContent("운영 상태를 불러오지 못했습니다");
    expect(screen.queryByText("오늘 발행 0건")).not.toBeInTheDocument();
  });

  it("중지 설정이 실패하면 상태와 토글을 되돌리고 오류를 알린다", async () => {
    const active = status();
    active.policy.publishingEnabled = true;
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: active }))
      .mockResolvedValueOnce(Response.json({ code: "storage_unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    render(React.createElement(CommunityAgentPanel));

    const pause = await screen.findByRole("button", { name: "일시 중지" });
    fireEvent.click(pause);

    expect(await screen.findByRole("alert")).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(screen.getByRole("button", { name: "일시 중지" })).toBeEnabled();
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(
      "/api/admin/agent/community",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "configure", patch: { enabled: false, publishingEnabled: false } }),
      }),
    ));
  });

  it("승인된 출처 링크와 한국어 수집 상태를 표시한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status() })));

    render(React.createElement(CommunityAgentPanel));

    expect(await screen.findByRole("link", { name: /디시인사이드 배틀그라운드/ })).toHaveAttribute("href", "https://gall.dcinside.com/board/lists/?id=battlegrounds");
    expect(screen.getByRole("link", { name: /PUBG: BATTLEGROUNDS Korea/ })).toHaveAttribute("href", "https://www.youtube.com/@PUBG_KR");
    expect(screen.getByText(/상태: 중지됨/)).toBeInTheDocument();
  });

  it("시험 실행이 보류된 실행에서 발행이나 다음 단계를 호출하지 않는다", async () => {
    const deferred: CommunityAgentStatus["runs"][number] = {
      id: "11111111-1111-4111-8111-111111111111",
      day: "2026-09-09",
      status: "deferred",
      stages: {}, modelCalls: 0, reports: [], topic: null, draft: null, validation: null, dryRun: false, postId: null, reason: "no_usable_evidence",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: deferred }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [deferred] }) }));
    vi.stubGlobal("fetch", fetch);

    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));

    await waitFor(() => expect(screen.getByText(/최근 실행: 보류/)).toBeInTheDocument());
    const bodies = fetch.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body));
    expect(bodies).toContain(JSON.stringify({ action: "start", dryRun: true }));
    expect(bodies.some((body) => body.includes('"action":"step"') || body.includes('"action":"publish"'))).toBe(false);
  });

  it("유튜브 수집 버튼은 해당 출처만 바꾸고 자동 게시를 켜지 않는다", async () => {
    const current = status();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: current }))
      .mockResolvedValueOnce(Response.json({ policy: { ...current.policy, sourceEnabled: { ...current.policy.sourceEnabled, youtube: true } } }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "유튜브 수집 켜기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "유튜브 수집 끄기" })).toHaveAttribute("aria-pressed", "true"));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "configure", patch: { sourceEnabled: { dc: true, naver: true, youtube: true } } });
    expect(screen.getAllByText("API 키 등록됨 · 실제 수집 결과는 실행 후 확인")).toHaveLength(2);
  });

  it("자동 게시 제어 없이 모든 초안을 사람 승인 대상으로 안내한다", async () => {
    const legacy = status();
    legacy.policy.publishingEnabled = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: legacy })));

    render(React.createElement(CommunityAgentPanel));

    expect(await screen.findByRole("region", { name: "게시글·답글 승인 대기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /자동 게시/ })).not.toBeInTheDocument();
    expect(screen.getByText(/모든 게시글과 답글은 BGMS AI 초안으로 저장/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "자료 수집·초안 만들기" })).toBeEnabled();
  });

  it("오늘 보류된 실행은 이전 실행 ID로 재시도하고 자동 게시하지 않는다", async () => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const held = status({ runs: [{
      id: "held", day, status: "deferred", stages: {}, modelCalls: 0, reports: [], topic: null, draft: null,
      validation: null, dryRun: true, postId: null, reason: "no_usable_evidence",
    }] });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: held }))
      .mockResolvedValueOnce(Response.json({ result: held.runs[0] }))
      .mockResolvedValueOnce(Response.json({ status: held }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    const trial = await screen.findByRole("button", { name: "다시 수집·초안 만들기" });
    expect(trial).toBeEnabled();
    fireEvent.click(trial);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "retry", runId: "held" });
    expect(screen.getByText(/이전 기록은 보존/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("게시글 초안을 만들지 못했습니다");
  });

  it("예약 암호 미설정은 수동 실행 오류로 표시하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status({ missingEnv: ["COMMUNITY_AGENT_WORKER_SECRET"] }) })));
    render(React.createElement(CommunityAgentPanel));
    expect(await screen.findByRole("button", { name: "자료 수집·초안 만들기" })).toBeEnabled();
    expect(screen.getByText("자동 예약 설정 · 수동 실행에는 필요 없음")).toBeInTheDocument();
    expect(screen.queryByText("설정 문제 상세")).not.toBeInTheDocument();
  });

  it("시험 실행 실패 뒤에도 오류를 보인다", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ code: "storage_unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: status() }));
    vi.stubGlobal("fetch", fetch);

    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("시험 실행을 완료하지 못했습니다");
  });

  it("재수집 중 단계와 새 실행 ID를 갱신하고 주제 없음 결과를 알린다", async () => {
    let releaseNaver: (() => void) | undefined;
    let latest = run();
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (!init?.body) return Response.json({ status: status({ runs: latest.status === "collecting" ? [] : [latest] }) });
      const body = JSON.parse(String(init.body));
      if (body.action === "start") return Response.json({ result: latest });
      const stage = body.stage as Stage;
      if (stage === "naver") await new Promise<void>((resolve) => { releaseNaver = resolve; });
      latest = run({
        stages: { ...latest.stages, [stage]: { status: "completed", lease: stage, result: {} } },
        reports: [{ source: "dc", state: "ok", reason: null, fetchedCount: 8, retainedCount: 8, evidenceIds: [] }],
        ...(stage === "select" ? { status: "deferred", reason: "no_publishable_topic" } : {}),
      });
      return Response.json({ result: latest });
    });
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("네이버 카페 수집 중"));
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent(latest.id);
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("조회 8건 · 채택 8건");
    expect(screen.getByRole("button", { name: "자료 수집·초안 작성 중…" })).toBeDisabled();
    releaseNaver?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Gemini가 작성할 주제를 선정하지 못했습니다"));
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("주제 선정 · 보류");
    expect(fetch.mock.calls.some(([, init]) => String(init?.body).includes('"stage":"draft"'))).toBe(false);
  });

  it.each([
    ["duplicate_topic", "최근 게시글과 겹치는 주제"],
    ["insufficient_topic_sources", "서로 다른 출처가 부족"],
    ["unverified_official_update", "공식 업데이트를 확인할 근거가 부족"],
    ["no_relevant_topic", "배그 게시글로 다룰 주제를 찾지 못"],
    ["insufficient_topic_evidence", "구체적인 내용이 부족"],
  ])("%s 보류 사유를 한국어로 표시한다", async (reason, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status({ runs: [run({ status: "deferred", reason })] }) })));
    render(React.createElement(CommunityAgentPanel));
    const details = await screen.findByLabelText("최근 실행 상세");
    expect(details).toHaveTextContent(message);
    expect(details).toHaveTextContent("시간 기록 없음");
  });

  it("검증 실패는 작성된 초안과 승인 대기 미등록 상태를 함께 보여준다", async () => {
    const rejected = run({ status: "deferred", reason: "validation_failed", draft: { title: "검증 전 초안", paragraphs: [], question: "어떻게 생각하세요?" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status({ runs: [rejected] }) })));
    render(React.createElement(CommunityAgentPanel));
    expect(await screen.findByText("검증 전 초안")).toBeInTheDocument();
    expect(screen.getByText(/초안은 작성했지만 승인 대기에 등록하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("근거 검증을 통과하지 못했습니다");
  });

  it("선별 진단의 실자료·제외·추가 확인 수와 후보별 보류 이유를 표시한다", async () => {
    const held = run({ status: "deferred", reason: "insufficient_topic_evidence", stages: {
      select: { status: "failed", lease: "selection", result: {
        terminal: { status: "deferred", reason: "insufficient_topic_evidence" },
        selection: { storedCount: 24, usableCount: 12, inputCount: 15, emptyCount: 3, rejectedCount: 9,
          supplementalCount: 3, detail: "업데이트 근거가 구체적이지 않습니다.",
          candidates: [{ title: "차량 운용", reason: "서로 다른 출처의 근거가 부족합니다." }] },
      } },
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status({ runs: [held] }) })));
    render(React.createElement(CommunityAgentPanel));
    const diagnostics = await screen.findByLabelText("주제 선정 진단");
    expect(screen.getByLabelText("최근 실행 상세")).toContainElement(diagnostics);
    expect(diagnostics).toHaveTextContent("저장 자료 24건 · 실자료 사용 12건 · 모델 입력 15건");
    expect(diagnostics).toHaveTextContent("비어 제외 3건 · 거절 제외 9건 · 추가 확인 3건");
    expect(diagnostics).toHaveTextContent("선정 판단: 업데이트 근거가 구체적이지 않습니다.");
    expect(diagnostics).toHaveTextContent("후보 1: 차량 운용 · 보류 이유: 서로 다른 출처의 근거가 부족합니다.");
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("주제 선정 · 보류");
    expect(screen.getByLabelText("최근 실행 상세")).not.toHaveTextContent("주제 선정 · 실패");
  });

  it("진단이 없는 기존 실패 기록은 기존 단계와 사유만 표시한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status({ runs: [run({
      status: "failed", reason: "model_request_failed",
      stages: { select: { status: "failed", lease: "old", result: {} } },
    })] }) })));
    render(React.createElement(CommunityAgentPanel));
    expect(await screen.findByLabelText("최근 실행 상세")).toHaveTextContent("주제 선정 · 실패");
    expect(screen.queryByLabelText("주제 선정 진단")).not.toBeInTheDocument();
  });

  it("거절된 초안을 승인 대기 등록 실패로 안내하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status({ runs: [run({ status: "deferred", reason: "review_rejected" })] }) })));
    render(React.createElement(CommunityAgentPanel));
    expect(await screen.findByText(/거절한 초안은 처리 내역/)).toBeInTheDocument();
    expect(screen.queryByText(/승인 대기에 등록하지 못했습니다/)).not.toBeInTheDocument();
  });

  it("완료 응답의 실행 결과와 조회 응답의 실제 시작 시간을 보존한다", async () => {
    const ready = run({ status: "ready" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: ready }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [{ ...ready, createdAt: "2026-10-07T03:04:05.000Z" }] }) }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    await waitFor(() => expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("12:04:05"));
    expect(screen.getAllByRole("status").some((element) => element.textContent?.includes("초안 작성과 검증이 완료"))).toBe(true);
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent(ready.id);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("최종 상태 조회가 이전 기록을 반환해도 새 실행 결과를 유지한다", async () => {
    const final = run({ status: "deferred", reason: "duplicate_topic" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: final }))
      .mockResolvedValueOnce(Response.json({ status: status() }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("최근 게시글과 겹치는 주제"));
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent(final.id);
  });

  it.each([
    ["published", null, "게시글이 발행되었습니다."],
    ["deferred", "review_rejected", "초안을 거절했습니다"],
  ] as const)("최종 조회의 %s 결과를 이전 ready 응답으로 되돌리지 않는다", async (statusValue, reason, message) => {
    const ready = run({ status: "ready" });
    const reviewed = { ...ready, status: statusValue, reason, createdAt: "2026-10-07T03:04:05.000Z" };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: ready }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [reviewed] }) }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    await waitFor(() => expect(screen.getAllByRole("status").some((element) => element.textContent?.includes(message))).toBe(true));
    const details = screen.getByLabelText("최근 실행 상세");
    expect(details).toHaveTextContent("12:04:05");
    expect(details).toHaveTextContent(statusValue === "published" ? "최근 실행: 발행됨" : "초안을 거절했습니다");
    expect(details).not.toHaveTextContent("발행 준비됨");
  });

  it("최종 조회에 더 최근 재실행이 있으면 최신 실행을 표시한다", async () => {
    const finished = run({ status: "deferred", reason: "duplicate_topic" });
    const newest = run({ id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-10-07T03:05:00.000Z" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: finished }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [newest, { ...finished, createdAt: "2026-10-07T03:04:05.000Z" }] }) }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("실행이 아직 완료되지 않았습니다"));
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent(newest.id);
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("최근 실행: 수집 중");
  });

  it("완료 알림은 이후 새로고침의 발행 상태와 함께 갱신된다", async () => {
    const ready = run({ status: "ready" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: ready }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [ready] }) }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [{ ...ready, status: "published" }] }) }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(screen.getAllByRole("status").some((element) => element.textContent?.includes("초안 작성과 검증이 완료"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getAllByRole("status").some((element) => element.textContent?.includes("게시글이 발행되었습니다"))).toBe(true));
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("최근 실행: 발행됨");
    expect(screen.getAllByRole("status").some((element) => element.textContent?.includes("초안 작성과 검증이 완료"))).toBe(false);
  });

  it("동시에 진행 중인 단계가 반환되면 다음 단계 실행을 멈춘다", async () => {
    const running = run({ stages: { dc: { status: "running", lease: "existing", result: {} } } });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: run() }))
      .mockResolvedValueOnce(Response.json({ result: running }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [running] }) }));
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "자료 수집·초안 만들기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("이미 진행 중인 단계가 있습니다");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText("최근 실행 상세")).toHaveTextContent("디시인사이드 수집 진행 중");
  });
});
