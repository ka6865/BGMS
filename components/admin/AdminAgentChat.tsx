"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Cloud,
  Database,
  FileText,
  Link2,
  Loader2,
  RotateCcw,
  Search,
  Send,
  Settings,
  Terminal,
  User,
  X,
  XCircle
} from "lucide-react";
import AdminAgentMascot, { type AdminAgentMascotState } from "@/components/admin/AdminAgentMascot";
import ConfirmModal from "@/components/common/ConfirmModal";
import type { BotSettings, ChatMessage, ToolExecution } from "@/types/admin-bot";

const AGENT_CLIENT_TIMEOUT_MS = 45_000;

export const DEFAULT_ADMIN_BOT_SETTINGS: BotSettings = {
  botName: "BGMS AI 비서 봇",
  systemPrompt: "너는 배틀그라운드 지도 분석 서비스(BGMS)의 똑똑하고 친근한 공식 운영진이자 분석 AI 에이전트봇이야. 유저들에게는 지나친 비속어는 배제하고 적당히 위트가 넘치는 스마트한 구어체(존댓말)로 정제하여 글을 작성해야 해. 팩트 데이터가 주어지면 그대로 활용하고, 이미지 검색 노출을 위해 맵 이름과 구체적인 수치들을 생생하게 스토리텔링 형식으로 포스팅 본문에 배치해야 해. 특히, 게시판 등록용 본문을 작성할 때는 Markdown 문법을 절대 쓰지 말고 HTML 문법(<p>, <h3>, <ul>, <img src='이미지주소' /> 등)을 사용해 작성해 줘."
};

type AdminAgentChatMode = "page" | "sheet";

interface AdminAgentChatProps {
  mode?: AdminAgentChatMode;
  prefillPrompt?: string;
  prefillVersion?: number | string;
  autoSend?: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onOpenDashboard?: () => void;
  onOpenApprovals?: (approvalId?: string) => void;
  onApprovalCreated?: (approvalId?: string) => void;
  className?: string;
}

export default function AdminAgentChat({
  mode = "page",
  prefillPrompt,
  prefillVersion,
  autoSend = false,
  onBack,
  onClose,
  onOpenDashboard,
  onOpenApprovals,
  onApprovalCreated,
  className = ""
}: AdminAgentChatProps) {
  const isSheet = mode === "sheet";
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "model",
      content: isSheet
        ? "필요한 운영 질문을 여기서 바로 물어보세요. 승인이나 실행은 이 대시보드에서 계속 처리할 수 있습니다."
        : "안녕하세요, 운영자님. 저는 BGMS AI 비서입니다. 운영 점검, 비용 확인, 승인 요청 생성처럼 필요한 일을 말로 시켜주세요. 실제 수락/거절은 운영 대시보드에서 처리합니다.",
      timestamp: formatTime()
    }
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [prefillThinking, setPrefillThinking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [latestApprovalId, setLatestApprovalId] = useState<string | undefined>();
  const [activeBotMessageId, setActiveBotMessageId] = useState<string | undefined>();
  const [latestBotMessageId, setLatestBotMessageId] = useState<string | undefined>();
  const [settings, setSettings] = useState<BotSettings>(DEFAULT_ADMIN_BOT_SETTINGS);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadPendingApprovals = useCallback(async () => {
    const response = await fetch("/api/admin/agent/approvals");
    if (!response.ok) return;
    const data = await response.json();
    const approvals = data.approvals || [];
    setPendingApprovalCount(approvals.filter((approval: any) => approval.status === "pending").length);
  }, []);

  useEffect(() => {
    loadPendingApprovals();
  }, [loadPendingApprovals]);



  useEffect(() => {
    const scrollArea = messageScrollRef.current;
    if (!scrollArea) return;
    requestAnimationFrame(() => {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    });
  }, [messages, isLoading]);

  const handleReset = () => {
    setIsResetConfirmOpen(true);
  };

  const executeReset = () => {
    setIsResetConfirmOpen(false);
    setMessages([
      {
        id: "welcome",
        role: "model",
        content: "대화가 초기화되었습니다. 필요한 운영 작업을 다시 입력해 주세요.",
        timestamp: formatTime()
      }
    ]);
    setLatestApprovalId(undefined);
    setActiveBotMessageId(undefined);
    setLatestBotMessageId(undefined);
    setPrefillThinking(false);
    toast.success("대화 기록이 초기화되었습니다.");
  };

  const notifyApprovalCreated = (approvalId?: string) => {
    setLatestApprovalId(approvalId || "pending");
    onApprovalCreated?.(approvalId);
  };

  const openApprovalTarget = (approvalId?: string) => {
    onOpenApprovals?.(approvalId);
  };

  const sendAgentMessage = async (messageText: string) => {
    if (!messageText.trim() || isLoading) return;

    const userMessageContent = messageText.trim();
    setInputValue("");
    setIsLoading(true);
    setPrefillThinking(false);
    setLatestApprovalId(undefined);

    const abortController = new AbortController();
    const startedAt = Date.now();
    const timeoutId = window.setTimeout(() => abortController.abort(), AGENT_CLIENT_TIMEOUT_MS);

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: userMessageContent,
      timestamp: formatTime()
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);

    const botMsgId = `bot-${Date.now()}`;
    setActiveBotMessageId(botMsgId);
    setLatestBotMessageId(botMsgId);
    setMessages((prev) => [
      ...prev,
      {
        id: botMsgId,
        role: "model",
        content: "",
        timestamp: formatTime(),
        toolsUsed: []
      }
    ]);

    try {
      const historyPayload = nextMessages.slice(1, -1).map((message) => ({
        role: message.role,
        content: message.content
      }));

      const response = await fetch("/api/admin/bot/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          message: userMessageContent,
          systemPrompt: settings.systemPrompt,
          history: historyPayload
        })
      });

      if (!response.ok) throw new Error("서버와의 통신이 원활하지 않습니다.");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";

      if (reader) {
        while (true) {
          const remainingMs = AGENT_CLIENT_TIMEOUT_MS - (Date.now() - startedAt);
          if (remainingMs <= 0) {
            await reader.cancel().catch(() => undefined);
            abortController.abort();
            throw createClientTimeoutError();
          }

          const { done, value } = await withClientTimeout(
            reader.read(),
            remainingMs,
            () => {
              abortController.abort();
              reader.cancel().catch(() => undefined);
            }
          );
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const payload = JSON.parse(line);

              if (payload.type === "tool_start") {
                setMessages((prev) => prev.map((message) => {
                  if (message.id !== botMsgId) return message;
                  return {
                    ...message,
                    toolsUsed: [
                      ...(message.toolsUsed || []),
                      {
                        toolName: payload.toolName,
                        status: "running",
                        params: payload.params,
                        safetyLevel: payload.safetyLevel
                      }
                    ]
                  };
                }));
              } else if (payload.type === "tool_end") {
                setMessages((prev) => prev.map((message) => {
                  if (message.id !== botMsgId) return message;
                  const tools = (message.toolsUsed || []).map((tool) => (
                    tool.toolName === payload.toolName && tool.status === "running"
                      ? {
                          ...tool,
                          status: payload.status,
                          approvalId: payload.approvalId,
                          error: payload.status === "failed" ? payload.result : undefined
                        }
                      : tool
                  ));
                  return { ...message, toolsUsed: tools };
                }));
                if (payload.status === "approval_required") {
                  loadPendingApprovals();
                  notifyApprovalCreated(payload.approvalId);
                }
              } else if (payload.type === "approval_required") {
                loadPendingApprovals();
                notifyApprovalCreated(payload.approvalId);
              } else if (payload.type === "chunk") {
                fullText += payload.data;
                setMessages((prev) => prev.map((message) => (
                  message.id === botMsgId ? { ...message, content: fullText } : message
                )));
              }
            } catch {
              // 스트리밍 중 잘린 라인은 다음 chunk에서 이어질 수 있어 무시합니다.
            }
          }
        }
      }
    } catch (error: any) {
      const message = error?.name === "AbortError"
        ? "응답 시간이 45초를 넘어서 중단했습니다. 같은 질문을 다시 보내거나, 운영 대시보드에서 수동 점검을 먼저 실행해 주세요."
        : error.message || "연동 실패";
      setMessages((prev) => prev.map((item) => (
        item.id === botMsgId
          ? { ...item, content: `오류가 발생했습니다: ${message}` }
          : item
      )));
    } finally {
      window.clearTimeout(timeoutId);
      setIsLoading(false);
      setActiveBotMessageId(undefined);
      loadPendingApprovals();
    }
  };

  const handleSendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    await sendAgentMessage(inputValue);
  };

  useEffect(() => {
    if (!prefillPrompt) return;
    
    if (autoSend) {
      const timer = setTimeout(() => {
        sendAgentMessage(prefillPrompt);
      }, 100);
      return () => clearTimeout(timer);
    } else {
      setInputValue(prefillPrompt);
      setPrefillThinking(true);
      const frameId = requestAnimationFrame(() => inputRef.current?.focus());
      const timeoutId = window.setTimeout(() => setPrefillThinking(false), 1800);
      return () => {
        cancelAnimationFrame(frameId);
        window.clearTimeout(timeoutId);
      };
    }
  }, [prefillPrompt, prefillVersion, autoSend]);

  const headerMascotState: AdminAgentMascotState = latestApprovalId ? "approval" : isLoading || prefillThinking ? "thinking" : "idle";
  const sheetHeaderHelperText = latestApprovalId
    ? "승인 요청이 생겼어요. 대시보드에서 확인할 수 있습니다."
    : isLoading
      ? "자료 확인 중이에요."
      : prefillThinking
        ? "문구를 넣어뒀어요. 확인하고 보내주세요."
        : "대시보드 안에서 바로 물어봅니다.";

  const getMessageMascotState = (message: ChatMessage): AdminAgentMascotState => {
    if (latestApprovalId && message.id === latestBotMessageId) return "approval";
    if (message.id === activeBotMessageId && message.content === "") return "thinking";
    if (message.id === activeBotMessageId) return "speaking";
    return "idle";
  };

  return (
    <div className={`${isSheet ? "flex h-full min-h-0 w-full flex-col overflow-hidden bg-zinc-950 text-zinc-50" : "flex h-full min-h-0 w-full flex-col overflow-hidden bg-zinc-950 font-sans text-zinc-50 antialiased"} ${className}`}>
      <header className={`${isSheet ? "z-10 shrink-0 border-b border-zinc-800 bg-zinc-950 px-4 py-3" : "sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/90 p-3 backdrop-blur-md sm:p-4"}`}>
        {isSheet ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <AdminAgentMascot state={headerMascotState} size="md" approvalCount={pendingApprovalCount} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <h2 className="truncate text-sm font-bold text-zinc-100">BGMS 미니 AI 비서</h2>
                </div>
                <p className="truncate text-[11px] text-zinc-500">{sheetHeaderHelperText}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => openApprovalTarget(latestApprovalId === "pending" ? undefined : latestApprovalId)}
                className="relative rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-2 text-[11px] font-semibold text-emerald-300 active:border-emerald-400"
              >
                승인
                {pendingApprovalCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-zinc-950">
                    {pendingApprovalCount}
                  </span>
                )}
              </button>
              <button type="button" onClick={handleReset} aria-label="대화 리셋" className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-900 active:text-zinc-100" title="대화 리셋">
                <RotateCcw className="h-4 w-4" />
              </button>
              <button type="button" onClick={onClose} aria-label="AI 비서 닫기" className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-400 active:bg-zinc-900 active:text-zinc-100" title="닫기">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={onBack}
                aria-label="운영 대시보드로 돌아가기"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors active:bg-zinc-800 active:text-zinc-100"
                title="운영 대시보드로 돌아가기"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <h1 className="truncate text-sm font-bold tracking-tight text-zinc-100 sm:text-base">{settings.botName}</h1>
                </div>
                <p className="truncate text-[11px] text-zinc-400 sm:text-xs">말로 요청하고, 실행 관리는 대시보드에서 합니다.</p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onOpenDashboard}
                aria-label={pendingApprovalCount > 0 ? `운영 대시보드 열기, 승인 대기 ${pendingApprovalCount}건` : "운영 대시보드 열기"}
                className="relative flex min-h-11 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs font-semibold text-amber-300 transition-colors active:border-amber-400 sm:px-3"
                title="운영 대시보드"
              >
                <Activity className="h-4 w-4" />
                <span className="hidden sm:inline">운영 대시보드</span>
                {pendingApprovalCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-zinc-950">
                    {pendingApprovalCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={handleReset}
                aria-label="대화 리셋"
                className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-400 transition-colors active:bg-zinc-800 active:text-zinc-100"
                title="대화 리셋"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(!showSettings)}
                aria-label="봇 설정"
                aria-expanded={showSettings}
                className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${showSettings ? "bg-amber-500/10 text-amber-500" : "text-zinc-400 active:bg-zinc-800"}`}
                title="봇 설정"
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </header>

      {!isSheet && showSettings && (
        <div className="border-b border-zinc-800 bg-zinc-900/90 p-4">
          <label htmlFor="admin-agent-system-prompt" className="mb-2 block text-xs font-semibold text-amber-500">에이전트 페르소나 지침</label>
          <textarea
            id="admin-agent-system-prompt"
            value={settings.systemPrompt}
            onChange={(event) => setSettings({ ...settings, systemPrompt: event.target.value })}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs text-zinc-300 focus:border-amber-500 focus:outline-none"
            rows={4}
          />
          <div className="mt-2.5 flex justify-end">
            <button
              onClick={() => setShowSettings(false)}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 active:bg-amber-600"
            >
              지침 적용
            </button>
          </div>
        </div>
      )}

      <main
        ref={messageScrollRef}
        className={`${isSheet ? "min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-3" : "min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-3 pb-6 sm:p-4"}`}
      >
        {messages.map((message) => {
          const isUser = message.role === "user";
          return (
            <div key={message.id} className={`flex w-full gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
              {!isUser && (
                <div className="shrink-0 pt-0.5">
                  <AdminAgentMascot state={getMessageMascotState(message)} size="sm" />
                </div>
              )}

              <div className={`flex min-w-0 flex-col gap-1.5 ${isSheet ? "max-w-[88%]" : "max-w-[85%]"}`}>
                {!isUser && message.toolsUsed && message.toolsUsed.length > 0 && (
                  <div className="mb-1 flex min-w-0 flex-wrap gap-1.5">
                    {message.toolsUsed.map((tool, index) => (
                      <ToolChip
                        key={`${tool.toolName}-${index}`}
                        tool={tool}
                        onOpenApproval={() => openApprovalTarget(tool.approvalId)}
                      />
                    ))}
                  </div>
                )}

                <div className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm select-text ${
                  isUser
                    ? "rounded-tr-none bg-amber-500 font-medium text-zinc-950"
                    : "rounded-tl-none border border-zinc-800 bg-zinc-900 text-zinc-200"
                }`}>
                  {message.content === "" && isLoading && !message.toolsUsed?.some((tool) => tool.status === "running") ? (
                    <div className="flex items-center gap-1.5 py-1 text-zinc-400">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: "0ms" }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: "150ms" }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: "300ms" }} />
                    </div>
                  ) : (
                    message.content
                  )}
                </div>

                <span className="px-1 text-[10px] text-zinc-500">{message.timestamp}</span>
              </div>

              {isUser && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-zinc-300">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          );
        })}
        <div ref={chatEndRef} />
      </main>

      <footer className={`${isSheet ? "z-10 shrink-0 border-t border-zinc-800 bg-zinc-950/95 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]" : "z-10 w-full border-t border-zinc-800 bg-zinc-900/90 p-3 pb-[env(safe-area-inset-bottom)] backdrop-blur-md"}`}>
        {isSheet && latestApprovalId && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2 text-xs text-emerald-100">
            <div className="flex min-w-0 items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" />
              <span className="min-w-0 break-words">승인 요청이 생성되었습니다. 같은 대시보드에서 확인할 수 있어요.</span>
            </div>
            <button
              type="button"
              onClick={() => openApprovalTarget(latestApprovalId === "pending" ? undefined : latestApprovalId)}
              className="shrink-0 rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-bold text-zinc-950"
            >
              보기
            </button>
          </div>
        )}
        <form onSubmit={handleSendMessage} className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="운영 점검이나 승인 요청을 말로 시켜주세요..."
            aria-label="AI 비서에게 보낼 메시지"
            disabled={isLoading}
            className="min-w-0 flex-1 rounded-full border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!inputValue.trim() || isLoading}
            aria-label={isLoading ? "응답을 기다리는 중" : "메시지 보내기"}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500 text-zinc-950 transition-transform active:scale-95 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
      </footer>

      {/* 대화 기록 초기화 확인 모달 */}
      <ConfirmModal
        isOpen={isResetConfirmOpen}
        title="대화 기록 초기화"
        description="대화 기록을 초기화하시겠습니까?"
        confirmText="초기화"
        cancelText="취소"
        type="warning"
        onConfirm={executeReset}
        onCancel={() => setIsResetConfirmOpen(false)}
      />
    </div>
  );
}

function ToolChip({ tool, onOpenApproval }: { tool: ToolExecution; onOpenApproval: () => void }) {
  const isRunning = tool.status === "running";
  const isSuccess = tool.status === "success";
  const isApprovalRequired = tool.status === "approval_required";

  return (
    <button
      type="button"
      onClick={onOpenApproval}
      disabled={!tool.approvalId}
      title={tool.approvalId ? "운영 대시보드에서 이 요청 보기" : undefined}
      className={`flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium tracking-wide transition-all disabled:cursor-default ${
        isRunning
          ? "animate-pulse border-amber-500/30 bg-amber-500/5 text-amber-400"
          : isSuccess
            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
            : isApprovalRequired
              ? "border-sky-500/30 bg-sky-500/5 text-sky-400"
              : "border-rose-500/30 bg-rose-500/5 text-rose-400"
      }`}
    >
      <ToolIcon toolName={tool.toolName} />
      <span className="min-w-0 truncate">
        {getToolLabel(tool.toolName)}
        {isRunning ? " 중..." : isSuccess ? " 완료" : isApprovalRequired ? " 승인 대기" : " 실패"}
      </span>
      {isRunning ? (
        <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
      ) : isSuccess ? (
        <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
      ) : isApprovalRequired ? (
        <ClipboardCheck className="h-2.5 w-2.5 shrink-0" />
      ) : (
        <AlertCircle className="h-2.5 w-2.5 shrink-0" />
      )}
      {tool.approvalId && (
        <span className="ml-0.5 shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300">
          대시보드
        </span>
      )}
    </button>
  );
}

function ToolIcon({ toolName }: { toolName: string }) {
  const className = "h-3 w-3 shrink-0";
  if (toolName === "get_db_statistics") return <Database className={className} />;
  if (toolName === "take_map_screenshot") return <Link2 className={className} />;
  if (toolName === "tavily_search") return <Search className={className} />;
  if (toolName === "get_vercel_deployments") return <Cloud className={className} />;
  if (toolName === "get_vercel_build_logs") return <Terminal className={className} />;
  if (toolName.includes("approval") || toolName.includes("cache") || toolName.includes("memory")) return <ClipboardCheck className={className} />;
  if (toolName.includes("operations") || toolName.includes("readiness") || toolName.includes("monitor")) return <Activity className={className} />;
  if (toolName.includes("incident") || toolName.includes("risk")) return <AlertCircle className={className} />;
  if (toolName.includes("post") || toolName.includes("content") || toolName.includes("briefing") || toolName.includes("report")) return <FileText className={className} />;
  if (toolName.includes("cleanup")) return <XCircle className={className} />;
  return <FileText className={className} />;
}

function getToolLabel(toolName: string) {
  const labels: Record<string, string> = {
    get_db_statistics: "DB 집계",
    take_map_screenshot: "지도 캡처",
    tavily_search: "웹 검색",
    get_vercel_deployments: "배포 조회",
    get_vercel_build_logs: "빌드 분석",
    inspect_operations: "운영 진단",
    inspect_agent_readiness: "준비 점검",
    inspect_approval_queue: "승인 분석",
    inspect_incident_timeline: "사고 타임라인",
    inspect_handoff_packet: "인수인계",
    inspect_owner_brief: "운영자 브리핑",
    inspect_monitor_trend: "추세 점검",
    inspect_today_action_board: "오늘 액션",
    inspect_daily_checkout: "마감 점검",
    inspect_risk_radar: "위험 예측",
    inspect_approval_advisor: "승인 권고",
    inspect_mission_control: "미션 컨트롤",
    inspect_owner_inbox: "오너 인박스",
    inspect_final_readiness: "최종 점검",
    inspect_user_activity: "유저 활동",
    inspect_user_metrics: "유저 지표",
    search_agent_memories: "기억 검색",
    request_agent_memory: "기억 저장",
    generate_operations_briefing: "브리핑 생성",
    request_operations_report: "리포트 저장",
    generate_content_draft: "초안 생성",
    analyze_content_performance: "성과 분석",
    request_content_post: "콘텐츠 발행"
  };
  return labels[toolName] || "도구 실행";
}

function formatTime() {
  return new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function createClientTimeoutError() {
  const error = new Error("Agent client request timed out");
  error.name = "AbortError";
  return error;
}

function withClientTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      onTimeout();
      reject(createClientTimeoutError());
    }, Math.max(1, timeoutMs));

    promise
      .then((value) => {
        window.clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeout);
        reject(error);
      });
  });
}
