import { asRecord, type Calculations, type DataValue } from "./extract";
import { lookupString, type StringTable } from "./stringTable";

const STYLE_TAGS = {
  rules: "rules", keywordmajor: "keyword", status: "status", healing: "healing", attention: "attention",
  speed: "speed", magicdamage: "magicDamage", spellname: "spellName", shield: "shield", scalehealth: "scaleHealth",
  scaleap: "scaleAP", physicaldamage: "physicalDamage", evolve: "evolve", silver: "silver", gold: "gold",
  prismatic: "prismatic", flavortext: "flavor", truedamage: "trueDamage", scalead: "scaleAD",
  attackspeed: "attackSpeed", scalelevel: "scaleLevel", raritylegendary: "gold", b: "bold", i: "italic",
} as const;
export type TooltipStyle = typeof STYLE_TAGS[keyof typeof STYLE_TAGS] | "highlight" | "statIcon";
export type TooltipToken = { text: string; style: TooltipStyle[]; icon?: string; label?: string; formula?: true };
export type TooltipResult = {
  tokens: TooltipToken[];
  text: string;
  status: "ok" | "partial" | "failed";
  unresolvedTokens: string[];
  tokenCount: number;
  unresolvedTokenCount: number;
  unsupportedCalculations: string[];
  unknownIcons: string[];
};
type Range = { low: number; high: number; level?: true };
type Value = Range | { term: string; coefficient: Range; stack?: true; percentStat?: true }
  | { operator: "+"; left: Value; right: Value };

const STAT_ICONS: Record<string, [string, string]> = {
  scaleAP: ["spell_listtype_cherry_ap", "주문력"], scaleAD: ["spell_listtype_cherry_ad", "공격력"],
  scaleCrit: ["spell_listtype_cherry_critchance", "치명타 확률"], scaleCritMult: ["spell_listtype_cherry_critdamage", "치명타 피해량"],
  scaleAS: ["spell_listtype_cherry_as", "공격 속도"], OnHit: ["item_keyword_onhit", "적중 시"],
  Augment: ["aram_hextech_augbuffbar", "증강"], scaleHealth: ["game_resource_health", "체력"],
  goldCoins: ["options_interface_combattext_gold", "골드"], scaleHealShield: ["spell_listtype_healshieldpower", "체력 회복 및 보호막 효과"],
  scaleMana: ["game_ability_resource_mp", "마나"], scaleAPen: ["spell_listtype_cherry_lethality", "물리 관통력"],
  scaleMPen: ["stats_filter_magic_penetration", "마법 관통력"], miniAdaptiveForce: ["spell_listtype_adaptiveforce", "적응형 능력치"],
  scaleLS: ["spell_listtype_lifesteal", "생명력 흡수"], scaleCooldown: ["spell_listtype_cooldown", "재사용 대기시간"],
  cooldown: ["spell_listtype_cooldown", "재사용 대기시간"], StatAnvil: ["cherry_augmentdisplaytag_statanvil", "능력치 모루"],
  scaleAH: ["spell_listtype_abilityhaste", "스킬 가속"], scaleAR: ["stats_filter_armor", "방어력"],
  scaleArmor: ["stats_filter_armor", "방어력"], scaleMR: ["stats_filter_magic_resistance", "마법 저항력"],
  scaleMS: ["spell_listtype_movementspeed", "이동 속도"], scaleSV: ["spell_listtype_omnivamp", "모든 피해 흡혈"],
};
const STATS: Record<number, string> = {
  0: "주문력", 1: "방어력", 2: "공격력", 4: "공격 속도", 6: "마법 저항력", 7: "이동 속도",
  8: "치명타 확률", 9: "치명타 피해량", 11: "스킬 가속", 12: "최대 체력", 34: "체력 회복 및 보호막 효과",
};

function range(low: number, high = low): Range | null {
  return Number.isFinite(low) && Number.isFinite(high) ? { low: Math.min(low, high), high: Math.max(low, high) } : null;
}

function format(value: Value): string {
  if ("term" in value) return value.stack ? `중첩당 ${format(value.coefficient)}` : `${value.term}의 ${format(multiplyRange(value.coefficient, { low: 100, high: 100 })!)}%`;
  if ("operator" in value) return `${format(value.left)} + ${format(value.right)}`;
  const rounded = (number: number) => String(Number(number.toFixed(4)));
  return (value.low === value.high ? rounded(value.low) : `${rounded(value.low)}~${rounded(value.high)}`) + (value.level ? "(레벨에 따라)" : "");
}

function formatPercent(value: Value): string | null {
  if ("low" in value) return `${format(value)}%`;
  if ("term" in value) {
    if (value.stack) return `중첩당 ${format(value.coefficient)}%`;
    const coefficient = multiplyRange(value.coefficient, { low: value.percentStat ? 0.01 : 100, high: value.percentStat ? 0.01 : 100 });
    return coefficient ? `${value.term} ${value.percentStat ? "1%" : "100"}당 ${format(coefficient)}%` : null;
  }
  const left = formatPercent(value.left);
  const right = formatPercent(value.right);
  if (left === null || right === null) return null;
  return `${left} (+${right})`;
}

function multiplyRange(left: Range, right: Range): Range | null {
  const values = [left.low * right.low, left.low * right.high, left.high * right.low, left.high * right.high];
  const result = range(Math.min(...values), Math.max(...values));
  return result && (left.level || right.level) ? { ...result, level: true } : result;
}

function multiply(left: Value, right: Value): Value | null {
  if ("low" in left && "low" in right) return multiplyRange(left, right);
  if ("low" in left) return multiply(right, left);
  if ("low" in right) {
    if ("term" in left) {
      const coefficient = multiplyRange(left.coefficient, right);
      return coefficient && (left.stack || multiplyRange(coefficient, { low: 100, high: 100 })) ? { ...left, coefficient } : null;
    }
    if (right.low === 1 && right.high === 1) return left;
    const first = multiply(left.left, right);
    const second = multiply(left.right, right);
    return first && second ? add(first, second) : null;
  }
  return null;
}

function add(left: Value, right: Value): Value | null {
  if ("low" in left && "low" in right) {
    const result = range(left.low + right.low, left.high + right.high);
    return result && (left.level || right.level) ? { ...result, level: true } : result;
  }
  if ("low" in left && left.low === 0 && left.high === 0) return right;
  return { operator: "+", left, right };
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (original, key: string) => {
    if (key[0] !== "#") return entities[key.toLowerCase()];
    const number = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : original;
  });
}

function safeTokens(source: string, formulas: readonly string[], iconLabel: (name: string) => string | null): TooltipToken[] {
  const cleaned = source.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const result: TooltipToken[] = [];
  const stack: { tag: string; style: TooltipStyle }[] = [];
  const append = (text: string, metadata: { icon?: string; label?: string; formula?: true } = {}) => {
    if (!text) return;
    const style = [...new Set(stack.map(item => item.style))];
    if (metadata.icon) style.push("statIcon");
    const previous = result.at(-1);
    if (previous && !previous.icon && !previous.formula && !metadata.icon && !metadata.formula && previous.style.join() === style.join()) previous.text += text;
    else result.push({ text, style, ...metadata });
  };
  for (const part of cleaned.split(/(<[^>]*>|%i:[^%]*%|\uE000\d+\uE001)/g)) {
    if (part.startsWith("%i:") && part.endsWith("%")) {
      const name = part.slice(3, -1);
      const label = iconLabel(name);
      if (label) append(label, { icon: name, label });
      continue;
    }
    if (/^\uE000\d+\uE001$/.test(part)) { append(formulas[Number(part.slice(1, -1))] ?? "", { formula: true }); continue; }
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
  const plainText = result.filter(token => !token.icon).map(token => token.text).join("");
  return result.map(token => token.icon && (plainText.includes(token.text)
    || (token.icon === "scaleAPen" && plainText.includes("방어구 관통력"))) ? { ...token, text: "" } : token);
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
  const unknownIcons = new Set<string>();
  const formulas: string[] = [];
  const iconLabel = (name: string) => {
    const entry = Object.hasOwn(STAT_ICONS, name) ? STAT_ICONS[name] : null;
    if (!entry) { unknownIcons.add(name); return null; }
    const label = context.stringTable ? lookupString(context.stringTable, entry[0]) : null;
    return label === null ? entry[1] : decodeEntities(label.replace(/%i:[^%]*%|<[^>]*>/g, "")).trim();
  };
  let tokenCount = 0;
  let unresolvedTokenCount = 0;
  const missing = (token: string) => { unresolved.add(token); unresolvedTokenCount++; return token; };
  // 등급별 배열은 0을 포함한 첫 유효값을 쓴다. 챔피언 레벨 계산은 끝점 범위를 표시한다.
  const data = (key: string): Range | null => {
    const value = values.get(key.toLowerCase())?.find(Number.isFinite);
    return value === undefined ? null : range(value);
  };
  const evaluateKey = (key: string, seen: Set<string>): Value | null => {
    const lower = key.toLowerCase();
    if (seen.has(lower) || seen.size >= 16) return null;
    return evaluate(calculations.get(lower), new Set([...seen, lower]));
  };
  const evaluate = (raw: unknown, seen: Set<string>, depth = 0): Value | null => {
    if (depth >= 16) return null;
    const part = asRecord(raw);
    const child = (value: unknown) => evaluate(value, seen, depth + 1);
    const type = part.__type;
    const unsupportedPart = () => { if (typeof type === "string") unsupported.add(type); return null; };
    switch (type) {
      case "NumberCalculationPart": return typeof part.mNumber === "number" ? range(part.mNumber) : null;
      case "NamedDataValueCalculationPart": return typeof part.mDataValue === "string" ? data(part.mDataValue) : null;
      case "ByCharLevelInterpolationCalculationPart":
        return typeof part.mStartValue === "number" && typeof part.mEndValue === "number" ? range(part.mStartValue, part.mEndValue) : null;
      case "StatByCoefficientCalculationPart":
      case "StatByNamedDataValueCalculationPart": {
        const stat = part.mStat === undefined ? 0 : part.mStat;
        const statName = typeof stat === "number" && Object.hasOwn(STATS, stat) ? STATS[stat] : null;
        const formula = part.mStatFormula === undefined ? 0 : part.mStatFormula;
        const coefficient = type === "StatByNamedDataValueCalculationPart"
          ? typeof part.mDataValue === "string" ? data(part.mDataValue) : null
          : typeof part.mCoefficient === "number" ? range(part.mCoefficient) : null;
        if (!statName || (formula !== 0 && formula !== 2) || !coefficient
          || !multiplyRange(coefficient, { low: 100, high: 100 })) return unsupportedPart();
        const term = formula === 2 ? `추가 ${stat === 12 ? "체력" : statName}` : statName;
        return { term, coefficient, ...([4, 8, 9, 34].includes(Number(stat)) ? { percentStat: true as const } : {}) };
      }
      case "AbilityResourceByCoefficientCalculationPart": {
        if ((part.mAbilityResource !== undefined && part.mAbilityResource !== 0)
          || (part.mAbilityResourceFormula !== undefined && part.mAbilityResourceFormula !== 0)
          || (part.mStatFormula !== undefined && part.mStatFormula !== 0)) return unsupportedPart();
        const coefficient = typeof part.mCoefficient === "number" ? range(part.mCoefficient) : null;
        return coefficient && multiplyRange(coefficient, { low: 100, high: 100 }) ? { term: "최대 마나", coefficient } : unsupportedPart();
      }
      case "BuffCounterByCoefficientCalculationPart":
      case "BuffCounterByNamedDataValueCalculationPart": {
        const coefficient = type === "BuffCounterByNamedDataValueCalculationPart"
          ? typeof part.mDataValue === "string" ? data(part.mDataValue) : null
          : typeof part.mCoefficient === "number" ? range(part.mCoefficient) : null;
        return typeof part.mBuffName === "string" && coefficient ? { term: "중첩", coefficient, stack: true } : unsupportedPart();
      }
      case "ByCharLevelBreakpointsCalculationPart": {
        if (Object.keys(part).some(key => !["__type", "mLevel1Value", "mInitialBonusPerLevel", "mBreakpoints"].includes(key))) return unsupportedPart();
        if (typeof part.mLevel1Value !== "number" || (part.mInitialBonusPerLevel !== undefined && typeof part.mInitialBonusPerLevel !== "number")) return unsupportedPart();
        const breakpoints = part.mBreakpoints === undefined ? [] : part.mBreakpoints;
        if (!Array.isArray(breakpoints)) return unsupportedPart();
        let value = part.mLevel1Value;
        const perLevel = Number(part.mInitialBonusPerLevel ?? 0);
        let previousLevel = 1;
        const points = [value];
        for (const rawPoint of breakpoints) {
          const point = asRecord(rawPoint);
          const level = point.mLevel;
          if (!Number.isInteger(level) || Number(level) <= previousLevel || Number(level) > 18
            || Object.keys(point).some(key => !["__type", "mLevel", "mAdditionalBonusAtThisLevel"].includes(key))) return unsupportedPart();
          const bonus = point.mAdditionalBonusAtThisLevel ?? 0;
          if (typeof bonus !== "number") return unsupportedPart();
          value += perLevel * (Number(level) - previousLevel - 1);
          points.push(value);
          value += perLevel + bonus;
          points.push(value);
          previousLevel = Number(level);
        }
        points.push(value + perLevel * (18 - previousLevel));
        const result = range(Math.min(...points), Math.max(...points));
        return result ? { ...result, level: true } : unsupportedPart();
      }
      case "{ee18a47b}": {
        const start = typeof part.StartDataValue === "string" ? data(part.StartDataValue) : null;
        const end = typeof part.EndDataValue === "string" ? data(part.EndDataValue) : null;
        return start && end ? range(start.low, end.high) : unsupportedPart();
      }
      case "GameCalculation":
      case "SumOfSubPartsCalculationPart": {
        const parts = type === "GameCalculation" ? part.mFormulaParts : part.mSubparts;
        if (!Array.isArray(parts) || !parts.length) return null;
        let sum: Value = { low: 0, high: 0 };
        for (const item of parts) {
          const value = child(item);
          if (!value) return null;
          const next = add(sum, value);
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
  const replaceVariable = (token: string, body: string, suffix: string): string => {
    tokenCount++;
    const match = /^([^@:*]+?)(?::Calc)?(?:\*(-?(?:\d+(?:\.\d*)?|\.\d+)))?$/i.exec(body);
    if (!match) return missing(token) + suffix;
    const key = match[1].toLowerCase();
    const calc = asRecord(calculations.get(key));
    const forceCalc = /:Calc(?:\*|$)/i.test(body);
    let value = forceCalc ? evaluateKey(key, new Set()) : data(key) ?? evaluateKey(key, new Set());
    const percent = calc.mDisplayAsPercent === true && match[2] === undefined && (forceCalc || !values.has(key));
    const multiplier = range(match[2] === undefined ? percent ? 100 : 1 : Number(match[2]));
    value = value && multiplier ? multiply(value, multiplier) : null;
    if (!value) return missing(token) + suffix;
    const formula = !("low" in value) || value.level === true;
    const rendered = percent || suffix ? formatPercent(value) : format(value);
    if (rendered === null) return missing(token) + suffix;
    if (!formula) return rendered;
    formulas.push(rendered);
    return `\uE000${formulas.length - 1}\uE001`;
  };
  const expand = (text: string, seen: Set<string>, depth: number): string => text.replace(/[\uE000\uE001]/g, "").replace(
    /\{\{([^{}]+)\}\}|@([^@]+)@(%?)/g,
    (token, reference: string | undefined, variable: string | undefined, suffix: string | undefined) => {
      if (variable !== undefined) return replaceVariable(suffix ? token.slice(0, -1) : token, variable, suffix ?? "");
      tokenCount++;
      const key = reference!.trim().toLowerCase();
      const value = context.stringTable ? lookupString(context.stringTable, key) : null;
      if (depth >= 8 || seen.has(key) || value === null) return missing(token);
      return expand(value, new Set([...seen, key]), depth + 1);
    },
  );
  const tokens = safeTokens(expand(source ?? "", new Set(), 0), formulas, iconLabel);
  const text = tokens.map(token => token.text).join("");
  return {
    tokens, text,
    status: !text.trim() ? "failed" : unresolvedTokenCount === 0 ? "ok" : unresolvedTokenCount < tokenCount ? "partial" : "failed",
    unresolvedTokens: [...unresolved], tokenCount, unresolvedTokenCount, unsupportedCalculations: [...unsupported].sort(), unknownIcons: [...unknownIcons].sort(),
  };
}
