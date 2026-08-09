"use client";

import type { StatsMode, StatsPartySize } from "@/types/stats-page";

export interface StatsOverviewControlsProps {
  mode: StatsMode;
  partySize: StatsPartySize;
  onModeChange(value: StatsMode): void;
  onPartySizeChange(value: StatsPartySize): void;
}

const MODES: readonly { value: StatsMode; label: string }[] = [
  { value: "ranked", label: "경쟁전" },
  { value: "normal", label: "일반전" },
];
const PARTY_SIZES: readonly { value: StatsPartySize; label: string }[] = [
  { value: "solo", label: "솔로" },
  { value: "duo", label: "듀오" },
  { value: "squad", label: "스쿼드" },
];

function ControlledButtons<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="flex min-w-0 flex-1 gap-1 rounded-xl bg-white/5 p-1" role="group" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`min-h-11 min-w-11 flex-1 rounded-lg px-3 text-xs font-black transition-colors ${
              selected ? "bg-amber-500 text-black" : "text-white/50 hover:bg-white/5 hover:text-white"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function StatsOverviewControls({
  mode,
  partySize,
  onModeChange,
  onPartySizeChange,
}: StatsOverviewControlsProps) {
  return (
    <div className="flex flex-col gap-2 md:flex-row lg:flex-col">
      <ControlledButtons label="통계 모드" options={MODES} value={mode} onChange={onModeChange} />
      <ControlledButtons label="파티 인원" options={PARTY_SIZES} value={partySize} onChange={onPartySizeChange} />
    </div>
  );
}
