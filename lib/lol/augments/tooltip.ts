import { asRecord, type Calculations, type DataValue } from "./extract";
import { lookupString, type StringTable } from "./stringTable";

const STYLE_TAGS = {
  rules: "rules", keywordmajor: "keyword", status: "status", healing: "healing", attention: "attention",
  speed: "speed", magicdamage: "magicDamage", spellname: "spellName", shield: "shield", scalehealth: "scaleHealth",
  scaleap: "scaleAP", physicaldamage: "physicalDamage", evolve: "evolve", silver: "silver", gold: "gold",
  prismatic: "prismatic", flavortext: "flavor", truedamage: "trueDamage", scalead: "scaleAD",
  attackspeed: "attackSpeed", scalelevel: "scaleLevel", raritylegendary: "gold", b: "bold", i: "italic",
} as const;
export type TooltipStyle = typeof STYLE_TAGS[keyof typeof STYLE_TAGS] | "highlight";
export type TooltipToken = { text: string; style: TooltipStyle[] };
export type TooltipResult = {
  tokens: TooltipToken[];
  text: string;
  status: "ok" | "partial" | "failed";
  unresolvedTokens: string[];
  tokenCount: number;
  unresolvedTokenCount: number;
  unsupportedCalculations: string[];
};
type Range = { low: number; high: number };

function range(low: number, high = low): Range | null {
  return Number.isFinite(low) && Number.isFinite(high) ? { low: Math.min(low, high), high: Math.max(low, high) } : null;
}

function multiply(left: Range, right: Range): Range | null {
  const values = [left.low * right.low, left.low * right.high, left.high * right.low, left.high * right.high];
  return range(Math.min(...values), Math.max(...values));
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (original, key: string) => {
    if (key[0] !== "#") return entities[key.toLowerCase()];
    const number = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : original;
  });
}

function safeTokens(source: string): TooltipToken[] {
  const cleaned = source.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const result: TooltipToken[] = [];
  const stack: { tag: string; style: TooltipStyle }[] = [];
  const append = (text: string) => {
    if (!text) return;
    const style = [...new Set(stack.map(item => item.style))];
    const previous = result.at(-1);
    if (previous && previous.style.join() === style.join()) previous.text += text;
    else result.push({ text, style });
  };
  for (const part of cleaned.split(/(<[^>]*>)/g)) {
    if (!part.startsWith("<") || !part.endsWith(">")) { append(decodeEntities(part)); continue; }
    const match = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>$/i.exec(part);
    if (!match) continue;
    const tag = match[2].toLowerCase();
    if (tag === "br") { if (!match[1]) append("\n"); continue; }
    if (match[1]) {
      const index = stack.map(item => item.tag).lastIndexOf(tag);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const style = tag === "font" && /^<font\s+color\s*=\s*['"]?#[0-9a-f]{6}['"]?\s*>$/i.test(part)
      ? "highlight" : STYLE_TAGS[tag as keyof typeof STYLE_TAGS];
    if (style) stack.push({ tag, style });
  }
  return result;
}

export function renderTooltip(source: string | null, context: {
  dataValues?: readonly DataValue[];
  calculations?: Calculations;
  stringTable?: StringTable;
} = {}): TooltipResult {
  const values = new Map((context.dataValues ?? []).map(value => [value.name.toLowerCase(), value.values]));
  const calculations = new Map(Object.entries(context.calculations ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const unsupported = new Set<string>();
  const unresolved = new Set<string>();
  let tokenCount = 0;
  let unresolvedTokenCount = 0;
  const missing = (token: string) => { unresolved.add(token); unresolvedTokenCount++; return token; };
  // 등급별 배열은 0을 포함한 첫 유효값을 쓴다. 챔피언 레벨 계산은 끝점 범위를 표시한다.
  const data = (key: string): Range | null => {
    const value = values.get(key.toLowerCase())?.find(Number.isFinite);
    return value === undefined ? null : range(value);
  };
  const evaluateKey = (key: string, seen: Set<string>): Range | null => {
    const lower = key.toLowerCase();
    if (seen.has(lower) || seen.size >= 16) return null;
    return evaluate(calculations.get(lower), new Set([...seen, lower]));
  };
  const evaluate = (raw: unknown, seen: Set<string>, depth = 0): Range | null => {
    if (depth >= 16) return null;
    const part = asRecord(raw);
    const child = (value: unknown) => evaluate(value, seen, depth + 1);
    const type = part.__type;
    switch (type) {
      case "NumberCalculationPart": return typeof part.mNumber === "number" ? range(part.mNumber) : null;
      case "NamedDataValueCalculationPart": return typeof part.mDataValue === "string" ? data(part.mDataValue) : null;
      case "ByCharLevelInterpolationCalculationPart":
        return typeof part.mStartValue === "number" && typeof part.mEndValue === "number" ? range(part.mStartValue, part.mEndValue) : null;
      case "GameCalculation":
      case "SumOfSubPartsCalculationPart": {
        const parts = type === "GameCalculation" ? part.mFormulaParts : part.mSubparts;
        if (!Array.isArray(parts) || !parts.length) return null;
        let sum: Range = { low: 0, high: 0 };
        for (const item of parts) {
          const value = child(item);
          if (!value) return null;
          const next = range(sum.low + value.low, sum.high + value.high);
          if (!next) return null;
          sum = next;
        }
        if (part.mMultiplier !== undefined) {
          const multiplier = child(part.mMultiplier);
          return multiplier ? multiply(sum, multiplier) : null;
        }
        return sum;
      }
      case "ProductOfSubPartsCalculationPart": {
        const left = child(part.mPart1);
        const right = child(part.mPart2);
        return left && right ? multiply(left, right) : null;
      }
      case "GameCalculationModified": {
        const base = typeof part.mModifiedGameCalculation === "string" ? evaluateKey(part.mModifiedGameCalculation, seen) : null;
        const multiplier = part.mMultiplier === undefined ? range(1) : child(part.mMultiplier);
        return base && multiplier ? multiply(base, multiplier) : null;
      }
      default:
        if (typeof type === "string") unsupported.add(type);
        return null;
    }
  };
  const format = (value: Range, percent: boolean) => {
    const rounded = (number: number) => String(Number(number.toFixed(4)));
    return (value.low === value.high ? rounded(value.low) : `${rounded(value.low)}~${rounded(value.high)}`) + (percent ? "%" : "");
  };
  const replaceVariable = (token: string, body: string): string => {
    tokenCount++;
    const match = /^([^@:*]+?)(?::Calc)?(?:\*(-?(?:\d+(?:\.\d*)?|\.\d+)))?$/i.exec(body);
    if (!match) return missing(token);
    const key = match[1].toLowerCase();
    const calc = asRecord(calculations.get(key));
    const forceCalc = /:Calc(?:\*|$)/i.test(body);
    let value = forceCalc ? evaluateKey(key, new Set()) : data(key) ?? evaluateKey(key, new Set());
    const percent = calc.mDisplayAsPercent === true && match[2] === undefined && (forceCalc || !values.has(key));
    const multiplier = range(match[2] === undefined ? percent ? 100 : 1 : Number(match[2]));
    value = value && multiplier ? multiply(value, multiplier) : null;
    return value ? format(value, percent) : missing(token);
  };
  const expand = (text: string, seen: Set<string>, depth: number): string => text.replace(
    /\{\{([^{}]+)\}\}|@([^@]+)@/g,
    (token, reference: string | undefined, variable: string | undefined) => {
      if (variable !== undefined) return replaceVariable(token, variable);
      tokenCount++;
      const key = reference!.trim().toLowerCase();
      const value = context.stringTable ? lookupString(context.stringTable, key) : null;
      if (depth >= 8 || seen.has(key) || value === null) return missing(token);
      return expand(value, new Set([...seen, key]), depth + 1);
    },
  );
  const tokens = safeTokens(expand(source ?? "", new Set(), 0));
  const text = tokens.map(token => token.text).join("");
  return {
    tokens, text,
    status: !text.trim() ? "failed" : unresolvedTokenCount === 0 ? "ok" : unresolvedTokenCount < tokenCount ? "partial" : "failed",
    unresolvedTokens: [...unresolved], tokenCount, unresolvedTokenCount, unsupportedCalculations: [...unsupported].sort(),
  };
}
