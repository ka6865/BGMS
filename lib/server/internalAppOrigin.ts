// 서버가 같은 앱의 다른 API(예: /api/pubg/match)를 호출할 때 쓸 주소.
// app/api/pubg/ai-summary/route.ts 의 internalMatchApiTarget 과 같은 규칙이다.
export interface InternalAppTarget {
  origin: string;
  headers?: Record<string, string>;
}

function vercelDeploymentOrigin(): string | null {
  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (!deploymentHost || deploymentHost.length > 253) return null;
  const vercelHostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/i;
  if (!vercelHostPattern.test(deploymentHost)) return null;
  return `https://${deploymentHost.toLowerCase()}`;
}

export function internalAppTarget(): InternalAppTarget {
  const isDevelopment = process.env.NODE_ENV === "development";
  const fallbackOrigin = isDevelopment ? "http://localhost:3000" : "https://bgms.kr";

  if (!isDevelopment) {
    const deploymentOrigin = vercelDeploymentOrigin();
    if (deploymentOrigin) {
      const protectionBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
      return {
        origin: deploymentOrigin,
        ...(protectionBypass ? { headers: { "x-vercel-protection-bypass": protectionBypass } } : {}),
      };
    }
  }

  const configuredOrigin = process.env.APP_URL?.trim()
    || (!isDevelopment ? process.env.NEXT_PUBLIC_SITE_URL?.trim() : "")
    || fallbackOrigin;
  try {
    const parsed = new URL(configuredOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { origin: fallbackOrigin };
    return { origin: parsed.origin };
  } catch {
    return { origin: fallbackOrigin };
  }
}
