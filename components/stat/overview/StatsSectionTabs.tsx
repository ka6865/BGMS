"use client";

import type { StatsSectionTab } from "@/types/stats-page";

export interface StatsSectionTabsProps {
  value: StatsSectionTab;
  onChange(value: StatsSectionTab): void;
}

const SECTION_TABS: readonly { value: StatsSectionTab; label: string }[] = [
  { value: "overview", label: "개인 분석 개요" },
  { value: "squad", label: "스쿼드 시너지" },
];

export function StatsSectionTabs({ value, onChange }: StatsSectionTabsProps) {
  return (
    <div className="flex gap-2 border-b border-white/5" role="group" aria-label="전적 분석 섹션">
      {SECTION_TABS.map((tab) => {
        const selected = value === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(tab.value)}
            className={`min-h-11 border-b-2 px-4 text-xs font-black transition-colors ${
              selected
                ? tab.value === "overview"
                  ? "border-amber-500 text-amber-500"
                  : "border-purple-500 text-purple-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
