import type { Augment } from "./extract";
import type { TooltipResult } from "./tooltip";

export type ValidationProblem = {
  code: "pool_change" | "missing_names" | "rarity_mismatch" | "unresolved_tokens";
  message: string;
  platformIds?: number[];
};

export function tooltipTokenStats(tooltips: readonly TooltipResult[]) {
  const tokenCount = tooltips.reduce((sum, tooltip) => sum + tooltip.tokenCount, 0);
  const unresolvedTokenCount = tooltips.reduce((sum, tooltip) => sum + tooltip.unresolvedTokenCount, 0);
  return { tokenCount, unresolvedTokenCount, ratio: tokenCount ? unresolvedTokenCount / tokenCount : 0 };
}

export function validateAugments(input: {
  current: readonly Augment[];
  previous?: readonly Augment[];
  tooltips: readonly TooltipResult[];
}): { ok: boolean; problems: ValidationProblem[] } {
  const problems: ValidationProblem[] = [];
  const publicPool = (entries: readonly Augment[]) => entries.filter(entry => !entry.isInternal && entry.enabled);
  const current = publicPool(input.current);
  if (input.previous) {
    const previous = publicPool(input.previous);
    if (Math.abs(current.length - previous.length) > previous.length * 0.3) {
      problems.push({ code: "pool_change", message: `일반 증강 풀 변동이 30%를 초과합니다: ${previous.length} → ${current.length}` });
    }
  }
  const missing = current.filter(entry => !entry.ko.name?.trim() || !entry.en.name?.trim()).map(entry => entry.platformId);
  if (missing.length > 3) problems.push({ code: "missing_names", message: `이름 누락이 3개를 초과합니다: ${missing.length}`, platformIds: missing });
  const mismatched = input.current.filter(entry => entry.rarity !== entry.rarityEvidence.cherry
    || entry.rarityEvidence.cherry !== entry.rarityEvidence.bin).map(entry => entry.platformId);
  if (mismatched.length) problems.push({ code: "rarity_mismatch", message: "증강 등급이 원본 간에 일치하지 않습니다.", platformIds: mismatched });
  const { ratio } = tooltipTokenStats(input.tooltips);
  if (ratio > 0.05) problems.push({ code: "unresolved_tokens", message: `미치환 토큰 비율이 5%를 초과합니다: ${(ratio * 100).toFixed(2)}%` });
  return { ok: problems.length === 0, problems };
}
