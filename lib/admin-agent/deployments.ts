export type DeploymentSeverity = "ok" | "warn" | "critical";

export type VercelDeploymentSummary = {
  uid: string;
  url?: string;
  state: string;
  creator?: string;
  createdAt?: string;
  ageMinutes?: number;
};

export type VercelDeploymentHealth = {
  provider: "vercel";
  configured: boolean;
  severity: DeploymentSeverity;
  latest: VercelDeploymentSummary | null;
  recentFailures: VercelDeploymentSummary[];
  message: string;
  error?: string;
};

const FAILURE_STATES = new Set(["ERROR", "CANCELED"]);
// Vercel API 가 응답하지 않아도 운영 화면 전체가 멈추지 않도록 제한한다.
const VERCEL_FETCH_TIMEOUT_MS = 8_000;

/** 배포 상태를 조회하지 못했을 때 쓰는 기본값입니다. */
export function unavailableDeploymentHealth(error: string): VercelDeploymentHealth {
  return {
    provider: "vercel",
    configured: Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID),
    severity: "warn",
    latest: null,
    recentFailures: [],
    message: "Vercel 배포 상태 조회 중 오류가 발생했습니다.",
    error
  };
}
const IN_PROGRESS_STATES = new Set(["BUILDING", "QUEUED", "INITIALIZING"]);

export async function fetchVercelDeploymentHealth(limit = 5): Promise<VercelDeploymentHealth> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (!token || !projectId) {
    return {
      provider: "vercel",
      configured: false,
      severity: "ok",
      latest: null,
      recentFailures: [],
      message: "Vercel API 환경변수가 없어 배포 상태 감시는 건너뜁니다."
    };
  }

  try {
    const params = new URLSearchParams({
      projectId,
      limit: String(Math.min(Math.max(limit, 1), 10))
    });
    const response = await fetch(`https://api.vercel.com/v6/deployments?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(VERCEL_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      return {
        provider: "vercel",
        configured: true,
        severity: "warn",
        latest: null,
        recentFailures: [],
        message: "Vercel 배포 상태를 조회하지 못했습니다.",
        error: await response.text()
      };
    }

    const data = await response.json();
    const deployments = (data.deployments || []).map(normalizeDeployment);
    const latest = deployments[0] || null;
    const recentFailures = deployments.filter((deployment: VercelDeploymentSummary) => FAILURE_STATES.has(deployment.state));
    const stuckDeployment = latest && IN_PROGRESS_STATES.has(latest.state) && Number(latest.ageMinutes || 0) >= 20;

    let severity: DeploymentSeverity = "ok";
    let message = latest ? `최근 Vercel 배포 상태: ${latest.state}` : "최근 Vercel 배포 기록이 없습니다.";

    if (latest && FAILURE_STATES.has(latest.state)) {
      severity = "critical";
      message = `최근 Vercel 배포가 실패 상태입니다: ${latest.state}`;
    } else if (recentFailures.length > 0 || stuckDeployment) {
      severity = "warn";
      message = stuckDeployment
        ? `최근 Vercel 배포가 ${latest.ageMinutes}분째 진행 중입니다: ${latest.state}`
        : `최근 Vercel 배포 실패 이력이 ${recentFailures.length}건 있습니다.`;
    }

    return {
      provider: "vercel",
      configured: true,
      severity,
      latest,
      recentFailures,
      message
    };
  } catch (error: any) {
    return {
      provider: "vercel",
      configured: true,
      severity: "warn",
      latest: null,
      recentFailures: [],
      message: error?.name === "TimeoutError"
        ? "Vercel 배포 상태 조회가 제한 시간 안에 끝나지 않았습니다."
        : "Vercel 배포 상태 조회 중 오류가 발생했습니다.",
      error: error.message || String(error)
    };
  }
}

function normalizeDeployment(deployment: any): VercelDeploymentSummary {
  const createdMs = Number(deployment.created || deployment.createdAt || 0);
  return {
    uid: deployment.uid,
    url: deployment.url,
    state: deployment.state || "UNKNOWN",
    creator: deployment.creator?.username || deployment.creator?.email,
    createdAt: createdMs ? new Date(createdMs).toISOString() : undefined,
    ageMinutes: createdMs ? Math.max(0, Math.round((Date.now() - createdMs) / 60000)) : undefined
  };
}
