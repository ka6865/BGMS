const DATABASE_CIRCUIT_OPEN_MS = 30_000;

let openUntil = 0;

const DATABASE_UNAVAILABLE_CODES = new Set([
  "PGRST002",
  "PGRST003",
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

export function isDatabaseCircuitOpen(now = Date.now()): boolean {
  if (openUntil <= now) {
    openUntil = 0;
    return false;
  }
  return true;
}

export function noteDatabaseUnavailable(now = Date.now()): void {
  openUntil = Math.max(openUntil, now + DATABASE_CIRCUIT_OPEN_MS);
}

export function noteDatabaseAvailable(): void {
  openUntil = 0;
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  if (DATABASE_UNAVAILABLE_CODES.has(code)) return true;

  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  if (
    message.includes("schema cache")
    || message.includes("could not connect to the database")
    || message.includes("database connection timeout")
    || message.includes("connection to server was lost")
  ) {
    return true;
  }

  return candidate.cause !== error && isDatabaseUnavailableError(candidate.cause);
}
