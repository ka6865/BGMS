import type { Augment } from "./extract";
import { renderTooltip, type TooltipResult } from "./tooltip";

export type AugmentDisplay = {
  displaySource: "tooltip" | "desc" | "desc_partial";
  text: string;
  tokens: TooltipResult["tokens"];
  notice: string | null;
};

export function chooseAugmentDisplay(tooltip: TooltipResult, description: TooltipResult): AugmentDisplay {
  if (tooltip.status === "ok" && tooltip.text.trim()) {
    return { displaySource: "tooltip", text: tooltip.text, tokens: tooltip.tokens, notice: null };
  }
  if (description.status === "ok" && description.text.trim()) {
    return { displaySource: "desc", text: description.text, tokens: description.tokens, notice: null };
  }
  const replace = (text: string) => description.unresolvedTokens.reduce(
    (value, token) => value.split(token).join("(수치 미확인)"), text,
  );
  return {
    displaySource: "desc_partial", text: replace(description.text),
    tokens: description.tokens.map(token => ({ ...token, text: replace(token.text) })),
    notice: "일부 수치는 게임 안에서 확인하세요",
  };
}

export type ValidationProblem = {
  code: "pool_change" | "missing_names" | "rarity_mismatch" | "empty_description";
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
  tooltips?: readonly TooltipResult[];
  descriptions?: readonly TooltipResult[];
  previousDescriptions?: readonly TooltipResult[];
}): { ok: boolean; problems: ValidationProblem[]; warnings: Array<{ code: "review"; message: string }> } {
  const problems: ValidationProblem[] = [];
  const warnings: Array<{ code: "review"; message: string }> = [];
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
  const empty = input.current.filter(entry => !entry.ko.description?.trim() || !entry.en.description?.trim()).map(entry => entry.platformId);
  if (empty.length) problems.push({ code: "empty_description", message: "설명이 비어 있는 증강이 있습니다.", platformIds: empty });
  const mismatched = input.current.filter(entry => entry.rarity !== entry.rarityEvidence.cherry
    || entry.rarityEvidence.cherry !== entry.rarityEvidence.bin).map(entry => entry.platformId);
  if (mismatched.length) problems.push({ code: "rarity_mismatch", message: "증강 등급이 원본 간에 일치하지 않습니다.", platformIds: mismatched });
  const descriptions = (entries: readonly Augment[]) => entries.filter(entry => !entry.isInternal).flatMap(entry => [
    renderTooltip(entry.ko.description, entry.rootSpell), renderTooltip(entry.en.description, entry.rootSpell),
  ]);
  const currentDescriptions = input.descriptions ?? descriptions(input.current);
  const previousDescriptions = input.previousDescriptions ?? (input.previous ? descriptions(input.previous) : undefined);
  const okRatio = (entries: readonly TooltipResult[]) => entries.filter(entry => entry.status === "ok").length / entries.length;
  if (previousDescriptions?.length && currentDescriptions.length
    && okRatio(previousDescriptions) - okRatio(currentDescriptions) > 0.1 + Number.EPSILON) {
    warnings.push({ code: "review", message: "설명 완전 치환 비율이 직전 대비 10%p 넘게 떨어졌습니다." });
  }
  return { ok: problems.length === 0, problems, warnings };
}
