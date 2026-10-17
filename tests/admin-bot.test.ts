import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as adminBotPOST } from "../app/api/admin/bot/run/route";
import { withAuthGuard } from "../utils/supabase/guard";
import { NextResponse } from "next/server";

// 1. Host variables safely before standard imports/mocks using vi.hoisted
const { 
  mockLaunch, 
  mockNewPage,
  mockGoto,
  mockScreenshot,
  mockClose
} = vi.hoisted(() => {
  const mockScreenshot = vi.fn().mockResolvedValue(Buffer.from("dummy-png-data"));
  const mockGoto = vi.fn();
  const mockSetViewport = vi.fn();
  const mockNewPage = vi.fn().mockResolvedValue({
    setViewport: mockSetViewport,
    goto: mockGoto,
    screenshot: mockScreenshot
  });
  const mockClose = vi.fn();
  const mockLaunch = vi.fn().mockResolvedValue({
    newPage: mockNewPage,
    close: mockClose
  });
  return { mockLaunch, mockNewPage, mockGoto, mockSetViewport, mockScreenshot, mockClose };
});

const { 
  mockSendMessage, 
  mockStartChat,
  MockGoogleGenerativeAI
} = vi.hoisted(() => {
  const mockSendMessage = vi.fn();
  const mockStartChat = vi.fn().mockReturnValue({
    sendMessage: mockSendMessage
  });
  const mockGetGenerativeModel = vi.fn().mockReturnValue({
    startChat: mockStartChat
  });

  class MockGoogleGenerativeAI {
    apiKey: string;
    constructor(apiKey: string) {
      this.apiKey = apiKey;
    }
    getGenerativeModel = mockGetGenerativeModel;
  }

  return { mockSendMessage, mockStartChat, mockGetGenerativeModel, MockGoogleGenerativeAI };
});

// 2. Auth Guard Mocking
vi.mock("../utils/supabase/guard", () => ({
  withAuthGuard: vi.fn(),
}));

// 3. Puppeteer Mocking
vi.mock("puppeteer", () => ({
  default: {
    launch: mockLaunch
  }
}));

// 4. Google Generative AI Mocking
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: MockGoogleGenerativeAI,
    SchemaType: {
      OBJECT: "OBJECT",
      STRING: "STRING"
    },
    HarmCategory: {
      HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
      HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH"
    },
    HarmBlockThreshold: {
      BLOCK_NONE: "BLOCK_NONE"
    }
  };
});

describe("🤖 Admin AI Bot API Route (E2E Logic Flow Verification)", () => {
  let mockSupabaseAdmin: any;
  let rawChain: any;
  let cacheChain: any;
  let errorChain: any;
  let postChain: any;
  let profileChain: any;
  let agentInsertChain: any;
  let agentUpdateChain: any;
  let agentRunChain: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_GEMINI_API_KEY = "dummy-gemini-key";

    // DB 쿼리 체인 초기화
    rawChain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    };

    cacheChain = {
      select: vi.fn().mockResolvedValue({
        data: [{ coaching_style: "친근한 칭찬형" }, { coaching_style: "팩폭 분석형" }],
        error: null
      })
    };

    errorChain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ status: 500, message: "Internal Server Error" }],
        error: null
      })
    };

    postChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: "new-post-123" },
        error: null
      })
    };

    profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { role: "admin" },
        error: null
      })
    };

    agentInsertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: "agent-log-id" },
        error: null
      })
    };

    agentUpdateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: null,
        error: null
      })
    };

    agentRunChain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((resolve) => resolve({
        data: [{
          id: "monitor-run",
          status: "completed",
          message: "scheduled operational monitor",
          summary: JSON.stringify({
            severity: "critical",
            alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
            approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
            dailyCheckout: {
              status: "blocked",
              label: "마감 차단",
              score: 48,
              summary: "Execution Gate block 때문에 마감 전 승인 요청 재검토가 필요합니다.",
              openRisks: ["Execution Gate block 1건"],
              tomorrowFocus: ["승인 대기 작업 재생성"],
              handoffPrompt: "Execution Gate block 승인 요청을 원인과 재생성 기준으로 정리해줘"
            },
            nextActions: [{
              id: "review-risky-approvals",
              priority: "high",
              category: "approval",
              urgencyScore: 92,
              title: "오래된/위험 승인 먼저 검토",
              reason: "high risk 1건",
              prompt: "승인 대기 작업을 impact와 체크리스트 기준으로 우선순위 정리해줘",
              expectedOutcome: "승인 대기열을 위험도 기준으로 정리합니다.",
              checklist: ["Execution Gate block 여부 확인"]
            }]
          }),
          error: null,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        }],
        error: null
      })),
      eq: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: "agent-log-id" },
        error: null
      }),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          summary: JSON.stringify({
            severity: "critical",
            alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
            approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
            dailyCheckout: {
              status: "blocked",
              label: "마감 차단",
              score: 48,
              summary: "Execution Gate block 때문에 마감 전 승인 요청 재검토가 필요합니다.",
              openRisks: ["Execution Gate block 1건"],
              tomorrowFocus: ["승인 대기 작업 재생성"],
              handoffPrompt: "Execution Gate block 승인 요청을 원인과 재생성 기준으로 정리해줘"
            },
            nextActions: [{
              id: "review-risky-approvals",
              priority: "high",
              category: "approval",
              urgencyScore: 92,
              title: "오래된/위험 승인 먼저 검토",
              reason: "high risk 1건",
              prompt: "승인 대기 작업을 impact와 체크리스트 기준으로 우선순위 정리해줘",
              expectedOutcome: "승인 대기열을 위험도 기준으로 정리합니다.",
              checklist: ["Execution Gate block 여부 확인"]
            }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      })
    };
    agentRunChain.insert.mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: "agent-log-id" },
          error: null
        })
      })
    });
    agentRunChain.update.mockReturnValue({
      eq: vi.fn().mockResolvedValue({
        data: null,
        error: null
      })
    });

    // Storage mock
    const mockStorageList = vi.fn().mockResolvedValue({ data: [{ name: "map-captures" }], error: null });
    const mockStorageUpload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const mockStorageGetUrl = vi.fn().mockReturnValue({ data: { publicUrl: "https://mock.storage/map-captures/miramar.png" } });

    mockSupabaseAdmin = {
      from: vi.fn((table) => {
        if (table === "profiles") return profileChain;
        if (table === "match_stats_raw") return rawChain;
        if (table === "match_ai_coaching_cache") return cacheChain;
        if (table === "pubg_api_errors") return errorChain;
        if (table === "posts") return postChain;
        if (table === "agent_runs") return agentRunChain;
        if (table === "agent_steps") return { ...agentInsertChain, ...agentUpdateChain };
        if (table === "agent_approvals") return { ...agentInsertChain, ...agentUpdateChain };
        return {};
      }),
      storage: {
        listBuckets: mockStorageList,
        from: vi.fn(() => ({
          upload: mockStorageUpload,
          getPublicUrl: mockStorageGetUrl
        }))
      }
    };
  });

  it("1. 어드민이 아닐 경우 401 Unauthorized 에러를 반환해야 함", async () => {
    (withAuthGuard as any).mockResolvedValue({
      error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })
    });

    const req = new Request("http://localhost:3000/api/admin/bot/run", {
      method: "POST",
      body: JSON.stringify({ message: "인사하기" })
    });

    const res = await adminBotPOST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("로그인이 필요합니다");
  });

  it("2. 정상적인 어드민 세션이고 API Key가 존재할 때, Gemini 스트리밍 응답이 반환되어야 함", async () => {
    (withAuthGuard as any).mockResolvedValue({
      user: { id: "admin-id" },
      supabaseAdmin: mockSupabaseAdmin
    });

    // Gemini 응답 모킹
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "안녕하세요 관리자님. 무엇을 도울까요?",
        functionCalls: () => undefined
      }
    });

    const req = new Request("http://localhost:3000/api/admin/bot/run", {
      method: "POST",
      body: JSON.stringify({ message: "안녕하세요" })
    });

    const res = await adminBotPOST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");

    // ReadableStream 읽기
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += decoder.decode(value);
      }
    }

    expect(chunks).toContain("chunk");
    expect(chunks).toContain("안녕하세요 관리자님. 무엇을 도울까요?");
    expect(mockStartChat).toHaveBeenCalledWith(expect.objectContaining({
      systemInstruction: expect.objectContaining({
        parts: [expect.objectContaining({
          text: expect.stringContaining("Current server context snapshot")
        })]
      })
    }));
    const systemText = mockStartChat.mock.calls[0][0].systemInstruction.parts[0].text;
    expect(systemText).toContain("Latest monitor: critical");
    expect(systemText).toContain("Monitor trend:");
    expect(systemText).toContain("Daily checkout: 마감 차단");
    expect(systemText).toContain("Owner brief: act_now");
    expect(systemText).toContain("Owner do now");
    expect(systemText).toContain("Owner review items");
    expect(systemText).toContain("Operator value:");
    expect(systemText).toContain("Operator next leverage");
    expect(systemText).toContain("Growth roadmap:");
    expect(systemText).toContain("Growth primary prompt");
    expect(systemText).toContain("Automation contract:");
    expect(systemText).toContain("Free-plan guardrails:");
    expect(systemText).toContain("monitor trend tool");
    expect(systemText).toContain("automation contract tool");
    expect(systemText).toContain("capability matrix tool");
    expect(systemText).toContain("growth roadmap tool");
    expect(systemText).toContain("today action board tool");
    expect(systemText).toContain("daily checkout tool");
    expect(systemText).toContain("operating SOP tool");
    expect(systemText).toContain("Operating SOP:");
    expect(systemText).toContain("SOP primary prompt");
    expect(systemText).toContain("risk radar tool");
    expect(systemText).toContain("Risk radar:");
    expect(systemText).toContain("Risk primary prompt");
    expect(systemText).toContain("decision trace tool");
    expect(systemText).toContain("Decision trace:");
    expect(systemText).toContain("Decision blind spots:");
    expect(systemText).toContain("safety audit tool");
    expect(systemText).toContain("Safety audit:");
    expect(systemText).toContain("approval advisor tool");
    expect(systemText).toContain("Approval advisor:");
    expect(systemText).toContain("mission control tool");
    expect(systemText).toContain("Mission control:");
    expect(systemText).toContain("owner inbox tool");
    expect(systemText).toContain("Owner inbox:");
    expect(systemText).toContain("outcome review tool");
    expect(systemText).toContain("Outcome review:");
    expect(systemText).toContain("operator coach tool");
    expect(systemText).toContain("Operator coach:");
    expect(systemText).toContain("launch kit tool");
    expect(systemText).toContain("Launch kit:");
    expect(systemText).toContain("Launch first prompt:");
    expect(systemText).toContain("final readiness tool");
    expect(systemText).toContain("Final readiness:");
    expect(systemText).toContain("Today action board: blocked");
    expect(systemText).toContain("Today primary prompt");
    expect(systemText).toContain("Today board lanes");
  });

  it("3. AI가 'take_map_screenshot' 도구를 실행하도록 유도될 시, Puppeteer 캡처 로직이 가동되어야 함", async () => {
    (withAuthGuard as any).mockResolvedValue({
      user: { id: "admin-id" },
      supabaseAdmin: mockSupabaseAdmin
    });

    // 1차 응답: take_map_screenshot 도구 호출 요청
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "",
        functionCalls: () => [
          {
            name: "take_map_screenshot",
            args: { mapName: "miramar", layer: "secret_room" }
          }
        ]
      }
    });

    // 2차 응답 (sendMessage(functionResponses) 후): 최종 텍스트 결과
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "미라마 비밀의 방 지도를 캡처하여 업로드했습니다. [보기](https://mock.storage/map-captures/miramar.png)",
        functionCalls: () => undefined
      }
    });

    const req = new Request("http://localhost:3000/api/admin/bot/run", {
      method: "POST",
      body: JSON.stringify({ message: "미라마 지도 캡처해줘" })
    });

    // 캡처 안정화 대기(2500ms)는 요청 여부만 확인하고 즉시 진행한다
    const realSetTimeout = globalThis.setTimeout;
    const captureWaits: number[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 2500) {
        captureWaits.push(ms);
        return realSetTimeout(handler, 0);
      }
      return realSetTimeout(handler, ms, ...args);
    }) as typeof setTimeout);

    const res = await adminBotPOST(req);
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += decoder.decode(value);
      }
    }

    // 도구 시작/종료 로그 확인 및 최종 텍스트 덩어리 확인
    expect(chunks).toContain("tool_start");
    expect(chunks).toContain("take_map_screenshot");
    expect(chunks).toContain("tool_end");
    expect(chunks).toContain("miramar.png");
    
    setTimeoutSpy.mockRestore();
    expect(captureWaits).toEqual([2500]);

    // Puppeteer 캡처 → Storage 업로드 → 브라우저 종료 연결 확인
    expect(mockLaunch).toHaveBeenCalledOnce();
    expect(mockNewPage).toHaveBeenCalledOnce();
    expect(mockGoto).toHaveBeenCalledWith(
      expect.stringMatching(/\/maps\/miramar\?layer=secret_room&sidebar=false&notice=false$/),
      { waitUntil: "networkidle2" }
    );
    expect(mockScreenshot).toHaveBeenCalledWith({ type: "png" });
    expect(mockSupabaseAdmin.storage.from).toHaveBeenCalledWith("map-captures");
    const upload = mockSupabaseAdmin.storage.from.mock.results[0].value.upload;
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^miramar_secret_room_\d+\.png$/),
      Buffer.from("dummy-png-data"),
      { contentType: "image/png", upsert: true }
    );
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("4. AI가 'tavily_search' 도구를 실행하도록 유도될 시, Tavily 검색 요청이 성공해야 함", async () => {
    process.env.TAVILY_API_KEY = "dummy-tavily-key";
    
    // global.fetch 모킹
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: "29.2 패치에서는 M416 반동이 개선되었습니다.",
        results: [{ title: "PUBG 29.2 Patch Note", url: "https://pubg.com", content: "M416 Buff details" }]
      })
    });
    global.fetch = mockFetch;

    (withAuthGuard as any).mockResolvedValue({
      user: { id: "admin-id" },
      supabaseAdmin: mockSupabaseAdmin
    });

    // 1차 응답: tavily_search 도구 호출 요청
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "",
        functionCalls: () => [
          {
            name: "tavily_search",
            args: { query: "M416 패치 정보" }
          }
        ]
      }
    });

    // 2차 응답
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "검색 결과 M416의 반동이 버프되었습니다.",
        functionCalls: () => undefined
      }
    });

    const req = new Request("http://localhost:3000/api/admin/bot/run", {
      method: "POST",
      body: JSON.stringify({ message: "최근 M416 패치 알려줘" })
    });

    const res = await adminBotPOST(req);
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += decoder.decode(value);
      }
    }

    expect(chunks).toContain("tool_start");
    expect(chunks).toContain("tavily_search");
    expect(chunks).toContain("tool_end");
    expect(chunks).toContain("M416");
    expect(mockFetch).toHaveBeenCalled();
  });
});
