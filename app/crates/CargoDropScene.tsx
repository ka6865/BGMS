import React, { useState } from "react";
import { Sparkles } from "lucide-react";
import { CARGO_DROP_DURATION_MS } from "./useCratesState";

interface CargoDropSceneProps {
  crateName: string;
  crateImageUrl?: string | null;
  hasBonusEffect: boolean;
}

// 천장 조명과 선반 실루엣 배치. 화면 크기와 무관하게 비율 좌표를 쓴다.
const CEILING_LIGHTS = [
  { left: "12%", top: "9%", width: "9%" },
  { left: "34%", top: "14%", width: "7%" },
  { left: "52%", top: "7%", width: "10%" },
  { left: "71%", top: "12%", width: "8%" },
  { left: "86%", top: "18%", width: "6%" },
  { left: "22%", top: "22%", width: "6%" },
];
const SHELVES = [
  { left: "3%", width: "18%", height: "46%" },
  { left: "23%", width: "12%", height: "34%" },
  { left: "66%", width: "13%", height: "38%" },
  { left: "81%", width: "17%", height: "50%" },
];
const DUST = Array.from({ length: 12 }, (_, i) => {
  const side = i % 2 === 0 ? -1 : 1;
  return { x: side * (40 + ((i * 37) % 110)), y: -(8 + ((i * 23) % 34)), delay: (i % 4) * 0.03 };
});

/**
 * 화물(loot_crate) 개봉 연출. 어두운 창고 한가운데로 검은 화물이 떨어지고
 * 착지 순간 바닥 조명과 먼지가 퍼진 뒤 화물 표시등이 켜진다.
 */
export function CargoDropScene({ crateName, crateImageUrl, hasBonusEffect }: CargoDropSceneProps) {
  const [imageError, setImageError] = useState(false);
  const ledColor = hasBonusEffect ? "bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.95)]" : "bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]";

  return (
    <div
      className="cargo-scene relative flex-1 min-h-[480px] sm:min-h-[550px] rounded-3xl overflow-hidden border border-slate-800/80 bg-[#050608]"
      style={{ "--cargo-duration": `${CARGO_DROP_DURATION_MS}ms` } as React.CSSProperties}
      data-testid="cargo-drop-scene"
    >
      <style>{`
        @keyframes cargoSceneIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cargoLightFlicker {
          0%, 8% { opacity: 0; }
          10% { opacity: 0.9; } 12% { opacity: 0.2; } 15%, 100% { opacity: 0.85; }
        }
        @keyframes cargoDrop {
          0%, 10% { transform: translate(-50%, -165%) scale(0.92); opacity: 0; }
          12% { opacity: 1; }
          40% { transform: translate(-50%, 0) scale(1, 1); animation-timing-function: ease-out; }
          44% { transform: translate(-50%, 4%) scale(1.04, 0.9); }
          52% { transform: translate(-50%, -7%) scale(0.98, 1.03); }
          60%, 100% { transform: translate(-50%, 0) scale(1); opacity: 1; }
        }
        @keyframes cargoShadow {
          0%, 10% { transform: translateX(-50%) scale(0.3); opacity: 0; }
          40%, 100% { transform: translateX(-50%) scale(1); opacity: 0.85; }
        }
        @keyframes cargoSpotlight {
          0%, 38% { opacity: 0; transform: translateX(-50%) scaleX(0.6); }
          46% { opacity: 1; transform: translateX(-50%) scaleX(1.15); }
          100% { opacity: 0.75; transform: translateX(-50%) scaleX(1); }
        }
        @keyframes cargoImpactShake {
          0%, 40% { transform: translate(0, 0); }
          42% { transform: translate(-3px, 4px); }
          45% { transform: translate(3px, -3px); }
          48% { transform: translate(-2px, 2px); }
          52%, 100% { transform: translate(0, 0); }
        }
        @keyframes cargoDust {
          0%, 40% { transform: translate(0, 0) scale(0.4); opacity: 0; }
          43% { opacity: 0.8; }
          75%, 100% { transform: translate(var(--dust-x), var(--dust-y)) scale(1.6); opacity: 0; }
        }
        @keyframes cargoLed {
          0%, 58% { opacity: 0.15; }
          62% { opacity: 1; } 66% { opacity: 0.35; } 70%, 100% { opacity: 1; }
        }
        @keyframes cargoCaption {
          0%, 55% { opacity: 0; transform: translateY(6px); }
          70%, 100% { opacity: 1; transform: translateY(0); }
        }
        .cargo-scene { animation: cargoSceneIn 0.25s ease-out both; }
        .cargo-stage { animation: cargoImpactShake var(--cargo-duration) linear both; }
        .cargo-light { animation: cargoLightFlicker var(--cargo-duration) linear both; }
        .cargo-box { animation: cargoDrop var(--cargo-duration) cubic-bezier(0.55, 0, 1, 0.45) both; }
        .cargo-shadow { animation: cargoShadow var(--cargo-duration) cubic-bezier(0.55, 0, 1, 0.45) both; }
        .cargo-spotlight { animation: cargoSpotlight var(--cargo-duration) ease-out both; }
        .cargo-dust { animation: cargoDust var(--cargo-duration) ease-out both; }
        .cargo-led { animation: cargoLed var(--cargo-duration) linear both; }
        .cargo-caption { animation: cargoCaption var(--cargo-duration) ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .cargo-scene, .cargo-stage, .cargo-light, .cargo-box, .cargo-shadow,
          .cargo-spotlight, .cargo-dust, .cargo-led, .cargo-caption { animation: none; }
          .cargo-box { transform: translate(-50%, 0); }
          .cargo-shadow, .cargo-spotlight { transform: translateX(-50%); }
          .cargo-dust { opacity: 0; }
        }
      `}</style>

      <div className="cargo-stage absolute inset-0">
        {/* 창고 뒷벽과 선반 실루엣 */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,#16181c_0%,#08090b_60%,#030304_100%)]" />
        {SHELVES.map((shelf, i) => (
          <div
            key={i}
            className="absolute bottom-[38%] rounded-sm border border-slate-800/40 bg-[repeating-linear-gradient(180deg,#0e1013_0px,#0e1013_26px,#1a1d22_26px,#1a1d22_28px)] opacity-60"
            style={{ left: shelf.left, width: shelf.width, height: shelf.height }}
          />
        ))}
        {CEILING_LIGHTS.map((light, i) => (
          <div
            key={i}
            className="cargo-light absolute h-[3px] rounded-full bg-slate-100 shadow-[0_0_12px_rgba(255,255,255,0.7)]"
            style={{ left: light.left, top: light.top, width: light.width, animationDelay: `${i * 40}ms` }}
          />
        ))}

        {/* 바닥 */}
        <div className="absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-b from-[#141518] to-[#08090a] border-t border-slate-800/50" />
        <div className="cargo-spotlight absolute left-1/2 bottom-[9%] w-[70%] max-w-[420px] h-[16%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.32)_0%,rgba(255,255,255,0.08)_45%,transparent_70%)]" />
        <div className="cargo-shadow absolute left-1/2 bottom-[23%] w-[46%] max-w-[260px] h-6 rounded-[50%] bg-black/90 blur-md" />

        {/* 착지 먼지 */}
        <div className="absolute left-1/2 bottom-[25%]">
          {DUST.map((dust, i) => (
            <span
              key={i}
              className="cargo-dust absolute h-3 w-3 rounded-full bg-slate-400/30 blur-[3px]"
              style={{ "--dust-x": `${dust.x}px`, "--dust-y": `${dust.y}px`, animationDelay: `${dust.delay}s` } as React.CSSProperties}
            />
          ))}
        </div>

        {/* 검은 화물 */}
        <div className="cargo-box absolute left-1/2 bottom-[24%] w-[56%] max-w-[260px] aspect-[1.45] origin-bottom">
          <div className="relative h-full w-full rounded-xl border border-slate-700/60 bg-gradient-to-b from-[#24272c] via-[#121417] to-[#08090b] shadow-[0_18px_40px_rgba(0,0,0,0.9)]">
            {/* 뚜껑 띠와 손잡이 */}
            <div className="absolute inset-x-0 top-0 h-[20%] rounded-t-xl border-b border-black/70 bg-gradient-to-b from-[#2e3137] to-[#17191d]" />
            <div className="absolute left-1/2 top-[5%] h-[6%] w-[22%] -translate-x-1/2 rounded-sm bg-black/70" />
            {/* 측면 보강 리브 */}
            <div className="absolute left-[16%] top-[20%] bottom-[8%] w-[2px] bg-black/60" />
            <div className="absolute right-[16%] top-[20%] bottom-[8%] w-[2px] bg-black/60" />
            {/* 전면 명판 */}
            <div className="absolute left-1/2 top-[34%] flex h-[44%] w-[34%] -translate-x-1/2 items-center justify-center rounded-md border border-slate-700/70 bg-black/60">
              {crateImageUrl && !imageError ? (
                <img
                  src={crateImageUrl}
                  alt=""
                  className="max-h-[85%] max-w-[85%] object-contain opacity-80 grayscale-[35%]"
                  onError={() => setImageError(true)}
                />
              ) : (
                <span className="text-[9px] font-black tracking-[0.2em] text-slate-500">CARGO</span>
              )}
            </div>
            {/* 모서리 표시등 */}
            {["left-[5%]", "left-[9%]", "right-[9%]", "right-[5%]"].map((pos) => (
              <span key={pos} className={`cargo-led absolute bottom-[7%] h-[16%] w-[2.5px] rounded-full ${pos} ${ledColor}`} />
            ))}
            {["left-[3%]", "right-[3%]"].map((pos) => (
              <span key={pos} className={`cargo-led absolute top-[30%] h-[2.5px] w-[7%] rounded-full ${pos} ${ledColor}`} />
            ))}
          </div>
        </div>
      </div>

      {/* 하단 안내 */}
      <div className="cargo-caption absolute inset-x-0 bottom-[5%] z-10 px-4 text-center">
        <p className="text-sm sm:text-base font-black tracking-wide text-slate-100">{crateName}</p>
        {hasBonusEffect ? (
          <p className="mt-1 inline-flex items-center justify-center gap-1 text-[11px] font-black text-amber-300">
            <Sparkles className="h-3 w-3" /> 보너스 전리품 당첨!
          </p>
        ) : (
          <p className="mt-1 text-[11px] font-bold text-slate-500">화물을 여는 중...</p>
        )}
      </div>
    </div>
  );
}
