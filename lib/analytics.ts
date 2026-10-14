/**
 * BGMS Analytics Utility
 * GA4(gtag) 커스텀 이벤트 래퍼 — 타입 안전, 서버 사이드 safe
 */

// ─── 이벤트 정의 ────────────────────────────────────────────────────────────

export const ANALYTICS_EVENT_NAMES = [
  "page_view",
  "stats_searched",
  "battle_started",
  "battle_completed",
  "share_clicked",
  "squad_synergy_completed",
  "ai_squad_coaching_requested",
  "ai_analysis_opened",
  "replay_2d_opened",
  "tab_clicked",
  "map_viewed",
  "weapon_viewed",
  "feature_consumption",
  "crate_opened",
  "board_viewed",
  "post_viewed",
  "post_action"
] as const;

/**
 * 문서를 처음 연 페이지뷰의 유입 출처.
 * referrer_host는 외부 도메인, 'direct'(리퍼러 없음), 'internal'(같은 사이트) 중 하나이며 경로·검색어는 남기지 않는다.
 */
export type LandingAttribution = {
  landing: true;
  referrer_host: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;
const UTM_MAX_LENGTH = 100;

const MIRRORED_EVENTS = new Set<string>(ANALYTICS_EVENT_NAMES);
const SESSION_STORAGE_KEY = "bgms_analytics_session_id";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export type BgmsEvent =
  | {
      name: "page_view";
      params: {
        path: string;
        title?: string;
      } & Partial<LandingAttribution>;
    }
  | {
      name: "stats_searched";
      params: {
        nickname: string;
        platform: string;
        has_data: boolean;
        season_id?: string;
      };
    }
  | {
      name: "battle_started";
      params: {
        nick1: string;
        nick2: string;
        platform1?: string;
        platform2?: string;
        match_type: string;
      };
    }
  | {
      name: "battle_completed";
      params: {
        nick1: string;
        nick2: string;
        platform1?: string;
        platform2?: string;
        match_type: string;
        winner: string;             // nick1 | nick2 | draw
        score1: number;
        score2: number;
      };
    }
  | {
      name: "share_clicked";
      params: {
        method: "link_share" | "link_copy" | "image_share" | "image_copy" | "image_download";
        page: "stats" | "battle" | "squad";
      };
    }
  | {
      name: "squad_synergy_completed";
      params: {
        nickname: string;
        platform: string;
        match_count: number;
        members_count: number;
      };
    }
  | {
      name: "ai_squad_coaching_requested";
      params: {
        nickname: string;
        coaching_style: "spicy" | "mild";
        squad_grade: string;
      };
    }
  | {
      name: "ai_analysis_opened";
      params: { nickname: string; match_id: string };
    }
  | {
      name: "replay_2d_opened";
      params: { nickname: string; match_id: string };
    }
  | {
      name: "tab_clicked";
      params: { tab: string; nickname: string };
    }
  | {
      name: "map_viewed";
      params: {
        map_id: string;
        zoom_level?: number;
        view_mode?: string;
      };
    }
  | {
      name: "weapon_viewed";
      params: {
        weapon_id: string;
        category: string;
      };
    }
  | {
      name: "feature_consumption";
      params: {
        feature_name: "ai-coaching" | "squad-synergy" | "battle-compare" | "2d-replay" | "3d-replay" | "backpack-calculator" | "crate-simulator";
        status: "start" | "success" | "fail";
        error_type?: string;
      };
    }
  | {
      name: "crate_opened";
      params: {
        crate_id: string;
        open_count: number;
      };
    }
  | {
      name: "board_viewed";
      params: {
        category: string;
      };
    }
  | {
      name: "post_viewed";
      params: {
        post_id: string;
        category: string;
      };
    }
  | {
      name: "post_action";
      params: {
        action: "create_post" | "create_comment" | "promote_post";
        status: "success" | "fail";
        post_id?: string;
        error_type?: string;
      };
    };

// ─── 전역 배치 큐 및 타이머 ───────────────────────────────────────────

const eventQueue: any[] = [];
let flushTimer: any = null;
let isListenerBound = false;
const BATCH_INTERVAL_MS = 15000; // 15초 배치 주기
let cachedAccessToken: string | null = null;
let isAuthSubscribed = false;
let isLandingAttributionConsumed = false;

/**
 * 문서 로드 뒤 첫 호출에만 유입 출처를 돌려준다.
 * 이후 클라이언트 이동에서도 document.referrer가 그대로 남으므로 두 번째 호출부터는 null을 반환한다.
 */
export function consumeLandingAttribution(): LandingAttribution | null {
  if (typeof window === "undefined" || isLandingAttributionConsumed) return null;
  isLandingAttributionConsumed = true;

  const attribution: LandingAttribution = {
    landing: true,
    referrer_host: getReferrerHost(document.referrer, window.location.hostname)
  };
  const searchParams = new URLSearchParams(window.location.search);
  for (const key of UTM_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) attribution[key] = value.slice(0, UTM_MAX_LENGTH);
  }
  return attribution;
}

function getReferrerHost(referrer: string, currentHost: string) {
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (!host) return "direct";
    return host === currentHost.toLowerCase() ? "internal" : host;
  } catch {
    return "direct";
  }
}


// ─── 발송 함수 ──────────────────────────────────────────────────────────────

export function trackEvent(event: BgmsEvent): void {
  if (typeof window === "undefined") return;

  setupAuthSubscription();

  // 개발 환경(Local)에서 실시간으로 GA4 DebugView를 모니터링할 수 있도록 debug_mode 적용
  const params = {
    ...event.params,
    debug_mode: process.env.NODE_ENV === "development" ? true : undefined
  };

  if (typeof (window as any).gtag === "function") {
    (window as any).gtag("event", event.name, params);
  }

  enqueueEvent(event);
}

function enqueueEvent(event: BgmsEvent): void {
  if (!MIRRORED_EVENTS.has(event.name)) return;
  if (process.env.NEXT_PUBLIC_ANALYTICS_MIRROR_DISABLED === "true") return;
  if (getAnalyticsMirrorSkipReason()) return;

  const eventPayload = {
    name: event.name,
    params: event.params,
    sessionId: getOrCreateSessionId(),
    pagePath: window.location.pathname,
    pageTitle: document.title || (event.name === "page_view" ? event.params.title : undefined),
    referrerPath: document.referrer ? toPath(document.referrer) : undefined,
    clientEnvironment: getClientAnalyticsEnvironment(),
    sourceHost: window.location.hostname,
    isInternal: isLocalHostname(window.location.hostname)
  };

  eventQueue.push(eventPayload);

  // 첫 이벤트 적재 시 타이머 구동 및 이탈 감지 리스너 바인딩
  if (typeof window !== "undefined" && !flushTimer) {
    flushTimer = setInterval(flushQueue, BATCH_INTERVAL_MS);
    setupExitListeners();
  }
}

const MAX_KEEPALIVE_BYTES = 30 * 1024; // keepalive 안전 임계치 (30KB)

async function flushQueue(): Promise<void> {
  if (eventQueue.length === 0) return;

  const payloadsToSend = [...eventQueue];
  eventQueue.length = 0;

  const payloadStr = JSON.stringify(payloadsToSend);
  const payloadBytes = new Blob([payloadStr]).size;
  const accessToken = await getCurrentAccessToken();

  try {
    // 1. 로그인 유저인 경우 -> fetch + keepalive: true + Authorization 헤더 사용
    if (accessToken) {
      if (payloadBytes > MAX_KEEPALIVE_BYTES) {
        // 백그라운드 전송 용량 제한을 우회하기 위해 30개 단위의 청크로 쪼개어 발송
        const chunkSize = 30;
        for (let i = 0; i < payloadsToSend.length; i += chunkSize) {
          const chunk = payloadsToSend.slice(i, i + chunkSize);
          await fetch("/api/analytics/event", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify(chunk),
            keepalive: true,
            credentials: "same-origin"
          });
        }
      } else {
        await fetch("/api/analytics/event", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`
          },
          body: payloadStr,
          keepalive: true,
          credentials: "same-origin"
        });
      }
      return;
    }

    // 2. 비로그인 유저인 경우 -> sendBeacon 또는 일반 fetch 적용
    if (payloadBytes <= MAX_KEEPALIVE_BYTES && navigator.sendBeacon) {
      const blob = new Blob([payloadStr], { type: "application/json" });
      const accepted = navigator.sendBeacon("/api/analytics/event", blob);
      if (accepted) return;
    }

    // sendBeacon 미지원 또는 실패 시, 혹은 용량이 클 때 일반 fetch 처리
    if (payloadBytes > MAX_KEEPALIVE_BYTES) {
      const chunkSize = 30;
      for (let i = 0; i < payloadsToSend.length; i += chunkSize) {
        const chunk = payloadsToSend.slice(i, i + chunkSize);
        await fetch("/api/analytics/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
          keepalive: true,
          credentials: "same-origin"
        });
      }
    } else {
      await fetch("/api/analytics/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadStr,
        keepalive: true,
        credentials: "same-origin"
      });
    }
  } catch (err) {
    console.warn("[analytics] Failed to flush event queue:", err);
    // 실패 시 유실 방지를 위해 다시 큐의 앞에 추가 (최대 100개)
    if (eventQueue.length < 100) {
      eventQueue.unshift(...payloadsToSend);
    }
  }
}

function setupExitListeners(): void {
  if (typeof window === "undefined" || isListenerBound) return;
  isListenerBound = true;

  const handleExit = () => {
    void flushQueue();
  };

  window.addEventListener("beforeunload", handleExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      handleExit();
    }
  });
}

function getAnalyticsMirrorSkipReason() {
  const allowLocalMirror = process.env.NEXT_PUBLIC_ANALYTICS_MIRROR_LOCAL === "true";
  const host = window.location.hostname;
  if (!allowLocalMirror && process.env.NODE_ENV === "development") return "development_environment";
  if (!allowLocalMirror && isLocalHostname(host)) return "local_host";

  const allowedHosts = (process.env.NEXT_PUBLIC_ANALYTICS_ALLOWED_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(host.toLowerCase())) {
    return "host_not_allowed";
  }
  return null;
}

function getClientAnalyticsEnvironment() {
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
  if (vercelEnv) return vercelEnv;
  return process.env.NODE_ENV === "development" ? "development" : "production";
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return LOCAL_HOSTS.has(normalized) || normalized.endsWith(".local");
}

function setupAuthSubscription() {
  if (typeof window === "undefined" || isAuthSubscribed) return;
  isAuthSubscribed = true;

  import("@/lib/supabase")
    .then(({ supabase }) => {
      // 1. 최초 로드 시 비동기로 스토리지/쿠키 세션 동기 복원 시도
      supabase.auth.getSession().then(({ data }) => {
        cachedAccessToken = data.session?.access_token || null;
      }).catch(() => {
        cachedAccessToken = null;
      });

      // 2. 인증 상태 변경 리스너를 구독하여 동기화 유지
      supabase.auth.onAuthStateChange((_event, session) => {
        cachedAccessToken = session?.access_token || null;
      });
    })
    .catch((err) => {
      console.warn("[analytics] Failed to initialize auth subscription:", err);
      isAuthSubscribed = false;
    });
}

async function getCurrentAccessToken() {
  return cachedAccessToken;
}

function getOrCreateSessionId() {
  try {
    const current = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (current) return current;
    const next = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function toPath(value: string) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}
