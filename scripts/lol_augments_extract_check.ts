import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { extractAugments, extractAugmentPool } from "../lib/lol/augments/extract";
import { diffAugments } from "../lib/lol/augments/diff";
import { parseStringTable } from "../lib/lol/augments/stringTable";
import { renderTooltip } from "../lib/lol/augments/tooltip";
import { chooseAugmentDisplay, tooltipTokenStats, validateAugments } from "../lib/lol/augments/validate";

const { values } = parseArgs({ options: {
  "augment-lists": { type: "string" }, "cherry-augments": { type: "string" }, "kiwi-bin": { type: "string" },
  "stringtable-ko": { type: "string" }, "stringtable-en": { type: "string" },
  "previous-lists": { type: "string" }, "previous-cherry": { type: "string" },
} });

function load(path: string | undefined): unknown {
  if (!path) throw new Error("원본 경로가 필요합니다: --augment-lists --cherry-augments --kiwi-bin --stringtable-ko --stringtable-en");
  return JSON.parse(readFileSync(path, "utf8"));
}

try {
  const source = {
    augmentLists: load(values["augment-lists"]), cherryAugments: load(values["cherry-augments"]), kiwiBin: load(values["kiwi-bin"]),
    stringTableKo: load(values["stringtable-ko"]), stringTableEn: load(values["stringtable-en"]),
  };
  const augments = extractAugments(source);
  const ko = parseStringTable(source.stringTableKo);
  const en = parseStringTable(source.stringTableEn);
  const render = (locale: "ko" | "en", field: "tooltip" | "description" = "tooltip") => augments.map(augment => ({
    platformId: augment.platformId,
    ...renderTooltip(augment[locale][field], { ...augment.rootSpell, stringTable: locale === "ko" ? ko : en }),
  }));
  const renderedKo = render("ko");
  const renderedEn = render("en");
  const descriptionsKo = render("ko", "description");
  const descriptionsEn = render("en", "description");
  const displays = (tooltips: typeof renderedKo, descriptions: typeof renderedKo) => tooltips.map((tooltip, index) => ({
    platformId: tooltip.platformId, ...chooseAugmentDisplay(tooltip, descriptions[index]),
  }));
  const failures = (rendered: typeof renderedKo) => rendered.filter(tooltip => tooltip.status !== "ok").map(tooltip => ({
    platformId: tooltip.platformId, status: tooltip.status, unresolvedTokens: tooltip.unresolvedTokens,
    unsupportedCalculations: tooltip.unsupportedCalculations,
  }));
  const unresolvedByCause = (rendered: typeof renderedKo) => {
    const counts = { runtime: 0, calculation: 0, stringReference: 0, missingValue: 0 };
    for (const tooltip of rendered) {
      const calculations = new Set(Object.keys(augments.find(augment => augment.platformId === tooltip.platformId)!.rootSpell.calculations).map(key => key.toLowerCase()));
      for (const token of tooltip.unresolvedTokens) {
        const key = /^@([^@:*]+)/.exec(token)?.[1].toLowerCase();
        const cause = token.startsWith("{{") ? "stringReference" : /^@f\d+(?:\.\d+)?@$/i.test(token) ? "runtime"
          : key && calculations.has(key) ? "calculation" : "missingValue";
        counts[cause] += tooltip.text.split(token).length - 1;
      }
    }
    return counts;
  };
  const previous = values["previous-lists"] || values["previous-cherry"]
    ? extractAugmentPool(load(values["previous-lists"]), load(values["previous-cherry"])) : null;
  const diff = previous ? diffAugments(previous, extractAugmentPool(source.augmentLists, source.cherryAugments)) : null;
  const generalIds = new Set(augments.filter(augment => !augment.isInternal).map(augment => augment.platformId));
  const validation = validateAugments({ current: augments,
    descriptions: [...descriptionsKo, ...descriptionsEn].filter(description => generalIds.has(description.platformId)),
  });
  const summary = {
    poolCount: augments.length,
    publicEnabledCount: augments.filter(augment => !augment.isInternal && augment.enabled).length,
    internalCount: augments.filter(augment => augment.isInternal).length,
    disabledCount: augments.filter(augment => !augment.enabled).length,
    missingNames: augments.filter(augment => !augment.ko.name || !augment.en.name).map(augment => augment.platformId),
    diff: diff ? {
      scope: "풀 구성·등급 비교이며 이전 kiwi.bin 없이 수치 변경은 비교하지 않습니다.",
      added: diff.added.map(augment => augment.platformId), removed: diff.removed.map(augment => augment.platformId),
      changed: diff.changed.map(change => ({ platformId: change.after.platformId, fields: change.fields })),
      internalAdded: diff.internal.added.map(augment => augment.platformId), internalRemoved: diff.internal.removed.map(augment => augment.platformId),
    } : null,
    ko: { ...tooltipTokenStats(renderedKo), unresolvedByCause: unresolvedByCause(renderedKo), failures: failures(renderedKo), displays: displays(renderedKo, descriptionsKo) },
    en: { ...tooltipTokenStats(renderedEn), unresolvedByCause: unresolvedByCause(renderedEn), failures: failures(renderedEn), displays: displays(renderedEn, descriptionsEn) },
    unknownIcons: [...new Set([...renderedKo, ...renderedEn, ...descriptionsKo, ...descriptionsEn].flatMap(tooltip => tooltip.unknownIcons))].sort(),
    unsupportedCalculations: [...new Set([...renderedKo, ...renderedEn].flatMap(tooltip => tooltip.unsupportedCalculations))].sort(),
    validation,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!validation.ok) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
