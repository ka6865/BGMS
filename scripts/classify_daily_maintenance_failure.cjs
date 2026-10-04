"use strict";

// CommonJS 형식으로 두어 runner의 기본 Node에서 바로 실행한다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TIMESTAMP = /(?:^|\s)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;
const BLUEZONE_ERROR_CATEGORIES = new Map([
  ["bluezone-pubg-rate-limited", "Bluezone PUBG rate limit"],
  ["bluezone-partial-fetch-failure", "Bluezone partial fetch failure"],
  ["bluezone-match-list-read-failed", "Bluezone match list read failure"],
  ["bluezone-stored-telemetry-read-failed", "Bluezone stored telemetry read failure"],
  ["bluezone-shared-source-invalid", "Bluezone shared archive invalid"],
  ["bluezone-legacy-source-invalid", "Bluezone legacy archive invalid"],
  ["bluezone-archive-read-failed", "Bluezone archive read failure"],
  ["bluezone-existing-data-unavailable", "Bluezone existing data unavailable"],
  ["bluezone-match-fetch-failed", "Bluezone match fetch failure"],
  ["bluezone-match-identity-mismatch", "Bluezone match identity mismatch"],
  ["bluezone-telemetry-asset-missing", "Bluezone telemetry asset missing"],
  ["bluezone-telemetry-fetch-failed", "Bluezone telemetry fetch failure"],
  ["bluezone-telemetry-identity-mismatch", "Bluezone telemetry identity mismatch"],
  ["bluezone-storage-upload-failed", "Bluezone storage upload failure"],
  ["bluezone-invalid-options", "Bluezone options invalid"],
  ["bluezone-invalid-limit", "Bluezone limit invalid"],
  ["bluezone-unexpected-failure", "Bluezone unexpected failure"],
]);

function timestampPrecisionPadding(value) {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  if (!fraction) return 999;
  return Math.max(0, 10 ** Math.max(0, 3 - fraction.length) - 1);
}

function extractFailedStepRuntimeLines(log, startedAt, completedAt, stepName) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const endInclusive = end + timestampPrecisionPadding(completedAt);
  const runtimeLines = [];
  let skippingRunGroup = false;

  for (const originalLine of String(log).split(/\r?\n/)) {
    const line = originalLine.replace(/^\uFEFF/, "").replace(ANSI_ESCAPE, "");
    const match = line.match(TIMESTAMP);
    if (!match) continue;

    const timestamp = Date.parse(match[1]);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > endInclusive) continue;

    const timestampIndex = line.indexOf(match[1], match.index ?? 0);
    const prefix = line.slice(0, timestampIndex).trim();
    if (stepName && prefix) {
      const prefixFields = prefix.split(/\t+/).filter(Boolean);
      if (prefixFields.length > 0 && !prefixFields.includes(stepName)) continue;
    }
    const body = line.slice(timestampIndex + match[1].length).trimStart();

    if (skippingRunGroup) {
      if (body === "##[endgroup]") skippingRunGroup = false;
      continue;
    }
    if (body.startsWith("##[group]Run ")) {
      skippingRunGroup = true;
      continue;
    }
    if (
      body.startsWith("##[group]") ||
      body === "##[endgroup]" ||
      body.startsWith("##[command]") ||
      body.startsWith("shell:") ||
      body === "env:" ||
      body === "with:" ||
      /^##\[error\]Process completed with exit code \d+\.?$/.test(body)
    ) {
      continue;
    }

    runtimeLines.push(body);
  }

  return runtimeLines;
}

function classifyFailedStepLog(log, startedAt, completedAt, stepName) {
  const lines = extractFailedStepRuntimeLines(log, startedAt, completedAt, stepName);
  const text = lines.join("\n");
  const categories = [];
  const stageCategories = new Set();
  const httpCodes = new Set();

  const rateLimited =
    /\bHTTP(?:\/\d(?:\.\d)?)?[\s:_-]*429\b/i.test(text) ||
    /\bstatus(?:Code)?\s*[:=]\s*429\b/i.test(text) ||
    /\btoo many requests\b/i.test(text) ||
    /\brate[ -]limit(?:\s+(?:exceeded|reached|exhausted))\b/i.test(text) ||
    /\brate_limited\s*[:=]\s*(?:true|1|yes)\b/i.test(text);
  const timedOut =
    /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED)\b/i.test(text) ||
    /\b(?:timed out|timeout)\b/i.test(text);

  for (const match of text.matchAll(/\bHTTP(?:\/\d(?:\.\d)?)?[\s:_-]*([45]\d{2})\b|\bstatus(?:Code)?\s*[:=]\s*([45]\d{2})\b/gi)) {
    const code = match[1] ?? match[2];
    if (code !== "429") httpCodes.add(code);
  }
  for (const match of text.matchAll(/\berrorCode\s*:\s*['"]?(bluezone-[a-z-]+)/gi)) {
    const category = BLUEZONE_ERROR_CATEGORIES.get(match[1].toLowerCase());
    if (category) stageCategories.add(category);
  }

  if (rateLimited) categories.push("rate limit");
  if (timedOut) categories.push("timeout");
  for (const code of [...httpCodes].sort()) categories.push("HTTP " + code);
  if (/Hotdrop 수집 실패/i.test(text)) categories.push("Hotdrop failure");
  if (/PUBG API\s+(?:error|failure)|PUBG API.*(?:failed|failure)/i.test(text)) {
    categories.push("PUBG API failure");
  }
  categories.push(...stageCategories);

  return categories;
}

if (require.main === module) {
  const [logPath, startedAt, completedAt, stepName] = process.argv.slice(2);
  if (!logPath || !startedAt || !completedAt || !stepName) process.exit(0);

  try {
    const log = fs.readFileSync(logPath, "utf8");
    const categories = classifyFailedStepLog(log, startedAt, completedAt, stepName);
    if (categories.length > 0) process.stdout.write(categories.join("\n") + "\n");
  } catch {
    process.exit(0);
  }
}

module.exports = {
  classifyFailedStepLog,
  extractFailedStepRuntimeLines,
};
