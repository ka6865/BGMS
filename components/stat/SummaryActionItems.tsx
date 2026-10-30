import { Target } from "lucide-react";

export interface SummaryActionItem {
  icon: string;
  title: string;
  desc: string;
}

/** 빈 제목·설명을 빼고 최대 3개만 남긴다(서버도 3개까지만 보낸다). */
export function visibleSummaryActionItems(items: readonly SummaryActionItem[] | undefined): SummaryActionItem[] {
  return (items ?? []).filter((item) => item.title.trim() !== "" && item.desc.trim() !== "").slice(0, 3);
}

/**
 * 최근 요약 종합 평가가 가리키는 다음 경기 점검 과제.
 * 모델이 보낸 icon 문자열("target", 이모지 등)은 표시하지 않고 같은 아이콘을 쓴다.
 */
export function SummaryActionItems({ items }: { items: readonly SummaryActionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="다음 경기 점검 과제" data-testid="summary-action-items" className="flex flex-col gap-3">
      <span className="text-[11px] text-indigo-300/80 font-black tracking-widest">다음 경기 점검 과제</span>
      <ul className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {items.map((item, idx) => (
          <li key={`${item.title}-${idx}`} data-testid="summary-action-item" className="flex items-start gap-3 min-w-0 p-4 bg-white/5 rounded-2xl border border-white/10">
            <Target size={18} className="mt-0.5 shrink-0 text-indigo-300" aria-hidden="true" />
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-sm font-black text-white break-keep break-words">{item.title}</span>
              <span className="text-xs text-gray-400 font-medium leading-relaxed break-keep break-words">{item.desc}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
