import "server-only";

export function isSameOriginLolRequest(request: Request) {
  const rawOrigin = request.headers.get("origin");
  const hostHeader = request.headers.get("host");
  if (!rawOrigin || !hostHeader) return false;

  try {
    const incomingUrl = new URL(request.url);
    const origin = new URL(rawOrigin);
    if ((incomingUrl.protocol !== "http:" && incomingUrl.protocol !== "https:") || origin.protocol !== incomingUrl.protocol) return false;
    if (rawOrigin !== origin.origin || origin.username || origin.password) return false;

    const requestHost = new URL(`${incomingUrl.protocol}//${hostHeader}`);
    return !requestHost.username
      && !requestHost.password
      && requestHost.pathname === "/"
      && !requestHost.search
      && !requestHost.hash
      && requestHost.host === origin.host;
  } catch {
    return false;
  }
}

