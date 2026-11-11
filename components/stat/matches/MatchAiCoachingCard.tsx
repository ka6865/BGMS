"use client";

// 단일 경기 AI 코칭 응답 카드. JSON 응답은 카드로, JSON이 아니거나 깨진 응답은 마크다운으로 그린다.
// 문장에 서버가 검증한 장면 ID가 있고 이 경기 타임라인에서 장면을 찾으면 장면 칩을 붙인다.

import React from "react";
import { MapPin } from "lucide-react";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { findMatchAiScene, matchAiSceneChipLabel, type MatchAiScene } from "@/lib/pubg-analysis/matchAiScenes";

/**
 * 간단한 마크다운 파서를 통해 AI 응답을 시각적으로 예쁘게 렌더링합니다.
 */
const renderMarkdown = (text: string) => {
  if (!text) return null;
  const lines = text.split('\n');

  return lines.map((line, idx) => {
    if (!line.trim()) return <div key={idx} className="h-2" />;

    let isHeader = false;
    let headerLevel = 0;
    if (line.startsWith('### ')) { isHeader = true; headerLevel = 3; }
    else if (line.startsWith('## ')) { isHeader = true; headerLevel = 2; }
    else if (line.startsWith('# ')) { isHeader = true; headerLevel = 1; }

    let content = line;
    if (isHeader) content = line.replace(/^#+\s/, '');

    const isList = /^[*\-]\s/.test(content.trim());
    const isBold = /\*\*(.*?)\*\*/g.test(content);

    let elements: React.ReactNode = content;
    if (isBold) {
      const parts = content.split(/(\*\*.*?\*\*)/g);
      elements = parts.map((part, pIdx) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={pIdx} className="text-white font-bold">{part.slice(2, -2)}</strong>;
        }
        return part;
      });
    }

    if (isHeader) {
      return (
        <div key={idx} className="flex items-center gap-2 mt-5 mb-3">
          <div className="w-1 h-4 bg-indigo-500 rounded-full shrink-0" />
          <h3 className={`font-black text-white ${headerLevel === 1 ? 'text-lg' : 'text-md'} break-keep`}>
            {elements}
          </h3>
        </div>
      );
    }

    if (isList) {
      return (
        <div key={idx} className="flex gap-2 mb-2 pl-2">
          <span className="text-indigo-400 shrink-0 mt-1">•</span>
          <span className="text-gray-300 text-sm leading-relaxed break-keep">{elements}</span>
        </div>
      );
    }

    return (
      <p key={idx} className="text-gray-400 text-sm leading-relaxed mb-3.5 pl-1 break-keep">
        {elements}
      </p>
    );
  });
};

// Tailwind v4는 조합한 클래스 이름을 만들지 않으므로 스타일별 클래스를 완성된 문자열로 둔다.
const THEMES = {
  mild: {
    spinner: "border-t-emerald-500",
    header: "from-emerald-500/10 border-emerald-500/20",
    badge: "bg-emerald-500/20 text-emerald-400",
    dot: "bg-emerald-500",
    verdictBorder: "border-emerald-500/30",
    verdictGlow: "bg-emerald-500/5",
    verdictLabel: "text-emerald-400",
  },
  spicy: {
    spinner: "border-t-red-500",
    header: "from-red-500/10 border-red-500/20",
    badge: "bg-red-500/20 text-red-400",
    dot: "bg-red-500",
    verdictBorder: "border-red-500/30",
    verdictGlow: "bg-red-500/5",
    verdictLabel: "text-red-400",
  },
} as const;

const SceneChip = ({ scene, onSelect }: { scene: MatchAiScene; onSelect: (scene: MatchAiScene) => void }) => {
  const label = matchAiSceneChipLabel(scene);
  return (
    <button
      type="button"
      data-testid="ai-scene-chip"
      aria-label={`${label} 장면을 경기 흐름 지도에서 보기`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(scene);
      }}
      className="mt-2 inline-flex min-h-11 self-start items-center gap-1.5 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 text-[11px] font-black text-sky-200 transition-colors hover:bg-sky-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
    >
      <MapPin size={12} aria-hidden="true" />
      {label}
    </button>
  );
};

type ActionItem = { icon?: unknown; title?: unknown; desc?: unknown; sceneId?: unknown };

export function MatchAiCoachingCard({
  analysis,
  isAnalyzing,
  coachingStyle,
  timeline,
  onSceneSelect,
}: {
  analysis: string;
  isAnalyzing: boolean;
  coachingStyle: "mild" | "spicy";
  timeline: unknown;
  onSceneSelect: (scene: MatchAiScene) => void;
}) {
  const markdown = (
    <div className="p-8 bg-black/40 rounded-[2.5rem] border border-white/10 prose prose-invert max-w-none">
      {renderMarkdown(analysis)}
    </div>
  );
  const cleanAnalysis = analysis.trim();
  const isJson = cleanAnalysis.startsWith('{') || cleanAnalysis.startsWith('```json');
  if (!isJson) return markdown;

  const isMildTheme = coachingStyle === "mild";
  const theme = THEMES[coachingStyle];
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(cleanAnalysis.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return markdown;
    data = parsed as Record<string, unknown>;
  } catch {
    // 스트리밍 중에는 JSON이 덜 도착해 파싱이 실패할 수 있다.
    if (!isAnalyzing) return markdown;
    return (
      <div className="p-10 bg-black/40 rounded-[2.5rem] border border-white/10 flex flex-col items-center justify-center gap-4">
        <div className={`w-10 h-10 border-4 border-white/10 ${theme.spinner} rounded-full animate-spin`} />
        <p className="text-gray-400 font-bold animate-pulse tracking-widest text-sm">AI 전술 데이터를 수신하고 있습니다...</p>
      </div>
    );
  }

  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? value : null);
  const briefFeedback = Array.isArray(data.briefFeedback) ? data.briefFeedback : [];
  // 구버전 응답에는 장면 필드가 없으므로 칩 없이 그린다.
  const sceneRefs = Array.isArray(data.briefFeedbackSceneIds) ? data.briefFeedbackSceneIds : [];
  const actionItems = (Array.isArray(data.actionItems) ? data.actionItems : [])
    .filter((item): item is ActionItem => Boolean(item) && typeof item === "object");

  return (
    <div className="flex flex-col gap-6">
      {/* Style Header */}
      <div className={`relative p-8 bg-gradient-to-br to-transparent border ${theme.header} rounded-[2.5rem] overflow-hidden`}>
        <div className="absolute top-0 right-0 p-6 opacity-10">
          <BgmsIcon name={isMildTheme ? "shield" : "flame"} size={88} />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-4">
            <span className={`px-3 py-1 ${theme.badge} rounded-full text-[10px] font-black uppercase tracking-widest`}>
              {text(data.coach) || (isMildTheme ? "KIND COACH" : "SPICY BOMBER")}
            </span>
            <div className={`h-1 w-1 rounded-full ${theme.dot}`} />
            <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">전술 매치 보고서</span>
          </div>
          <h3 className="text-3xl font-black text-white mb-2 leading-tight">{text(data.signature)}</h3>
          <p className="text-gray-400 text-sm font-medium">{text(data.signatureSub)}</p>
          {Boolean(data.signature) && (
            <p className="mt-2 text-[11px] font-bold text-gray-500 break-keep" data-testid="match-signature-scope">
              이번 한 경기 기록으로 붙인 별명입니다. 최근 경기 요약의 칭호와 다를 수 있습니다.
            </p>
          )}
        </div>
      </div>

      {/* Analysis Content (3 Lines) */}
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3">
          {briefFeedback.map((point, idx) => {
            const scene = findMatchAiScene(timeline, sceneRefs[idx]);
            return (
              <div key={idx} className="flex gap-4 p-4 bg-white/5 border border-white/10 rounded-2xl items-center group/point hover:bg-white/10 transition-colors">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  idx === 0 ? 'bg-amber-500/20 text-amber-500' :
                  idx === 1 ? 'bg-indigo-500/20 text-indigo-400' :
                  'bg-emerald-500/20 text-emerald-400'
                }`}>
                  <span className="text-xs font-black">{idx + 1}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-gray-200 text-sm font-medium leading-relaxed">
                    {text(point)}
                  </p>
                  {scene && <SceneChip scene={scene} onSelect={onSceneSelect} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Final Verdict & Action Items */}
      <div className={`p-8 bg-black/60 border ${theme.verdictBorder} rounded-[2.5rem] relative overflow-hidden shadow-2xl`}>
        <div className={`absolute inset-0 ${theme.verdictGlow} pointer-events-none`} />
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-4">
            <span className={`text-[10px] font-black ${theme.verdictLabel} uppercase tracking-[0.2em]`}>종합 코칭 진단</span>
            <div className="flex-1 h-px bg-white/5" />
          </div>
          <p className="text-xl font-black text-white leading-tight mb-8">&quot;{text(data.finalVerdict)}&quot;</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {actionItems.map((item, idx) => {
              const scene = findMatchAiScene(timeline, item.sceneId);
              return (
                <div key={idx} className="flex items-start gap-4 p-5 bg-white/5 rounded-[1.5rem] border border-white/10 hover:bg-white/10 transition-colors group/item">
                  <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-2xl group-hover/item:scale-110 transition-transform">
                    {text(item.icon)}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-black text-white">{text(item.title)}</span>
                    <span className="text-xs text-gray-400 leading-normal font-medium">{text(item.desc)}</span>
                    {scene && <SceneChip scene={scene} onSelect={onSceneSelect} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
