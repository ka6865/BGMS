import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { REPLAY_LONG_STEP_MS, REPLAY_STEP_MS } from "@/lib/replay/replayShortcuts";
import { VISION_RANGE_M } from "@/lib/replay/replayCamera";
import { ENGAGEMENT_LABEL_WINDOW_MS, FIGHT_LEAD_IN_MS } from "@/lib/replay/replayEngagements";

interface ReplayHelpDialogProps {
  open: boolean;
  onClose: () => void;
}

const seconds = (ms: number) => Math.round(ms / 1000);

const SECTIONS: { title: string; items: { term: string; text: string }[] }[] = [
  {
    title: "재생",
    items: [
      { term: "스페이스", text: "재생과 정지" },
      { term: "← →", text: `${seconds(REPLAY_STEP_MS)}초 뒤로·앞으로, Shift를 함께 누르면 ${seconds(REPLAY_LONG_STEP_MS)}초` },
      { term: "타임라인", text: "누른 시각으로 이동합니다. 처치·기절·아군 기절 표시를 눌러도 그 시각으로 갑니다." },
      { term: "다음 교전", text: `다음 아군 교전 ${seconds(FIGHT_LEAD_IN_MS)}초 전부터 재생합니다.` },
      { term: "링크", text: "지금 시각부터 재생되는 주소를 복사합니다. 좁은 화면에서는 설정 안에 있습니다." },
      { term: "?", text: "이 사용법을 엽니다." },
    ],
  },
  {
    title: "따라가기",
    items: [
      { term: "따라갈 선수", text: "고른 선수를 화면 가운데에 둡니다. 지도를 끌면 따라가기가 풀립니다." },
      { term: "자동 줌", text: "멈추면 가깝게, 차량으로 달리면 멀리 보도록 줌을 맞춥니다. 휠·핀치·더블클릭·+/- 키·Shift 드래그로 직접 줌하면 꺼지고, 다른 선수를 고르면 다시 켜집니다." },
      { term: "인지 범위", text: `따라가는 선수에게서 ${VISION_RANGE_M}m 밖이고 최근 ${seconds(ENGAGEMENT_LABEL_WINDOW_MS)}초 동안 아군과 교전하지 않은 적을 흐리게 그리고 이름을 숨깁니다.` },
    ],
  },
  {
    title: "지도 표시",
    items: [
      { term: "아군", text: "선수 칩과 같은 색 원입니다. 따라가는 선수는 하늘색 테두리가 붙습니다." },
      { term: "적", text: "원 안 숫자가 팀 번호입니다. 이름은 아군과 최근 교전한 적만 보이고, 설정에서 전체로 바꿀 수 있습니다." },
      { term: "기절", text: "빨갛게 깜빡이는 원입니다." },
      { term: "차량", text: "작은 상자이고 아래 점이 탑승자 색입니다." },
      { term: "투척", text: "던진 사람 위치에 종류(연막·수류탄 등)를 표시합니다." },
      { term: "폭발 피해", text: "폭발·화염에 맞은 사람 위치를 주황 원으로 표시합니다." },
      { term: "명중선", text: "공격자 위치에서 맞은 사람까지 빨간 선을 잠깐 그립니다." },
      { term: "보급 상자", text: "착지한 위치에 빨간 상자로 남습니다." },
      { term: "자기장", text: "파랗게 칠한 바깥이 자기장입니다. 흰 점선은 비행기 경로입니다." },
    ],
  },
  {
    title: "데이터 한계",
    items: [
      { term: "착탄·연막", text: "투척물이 떨어진 지점과 연막 범위는 기록에 없어 던진 위치만 보여 줍니다." },
      { term: "시야", text: "누가 누구를 봤는지는 기록에 없어 인지 범위는 거리와 최근 교전으로 추정한 값입니다." },
      { term: "이동", text: "위치는 약 10초마다 기록되어 그 사이는 직선으로 이어 그립니다." },
      { term: "경기 끝", text: "기본 리플레이는 우리 팀 전멸 30초 뒤까지입니다. 끝에서 경기 끝까지 이어 볼 수 있습니다." },
    ],
  },
];

// 2D 리플레이 사용법. 재생 패널이 transform으로 배치되어 있어 body에 포털로 띄운다.
export function ReplayHelpDialog({ open, onClose }: ReplayHelpDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[6000] flex items-end justify-center bg-black/60 p-3 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-help-title"
        className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#333] px-4 py-3">
          <h2 id="replay-help-title" className="text-sm font-black">리플레이 사용법</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="사용법 닫기"
            className="h-8 rounded border border-[#444] px-2.5 text-xs font-bold text-gray-300 hover:text-white"
          >
            닫기
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3">
          {SECTIONS.map((section) => (
            <section key={section.title} className="mb-4 last:mb-1">
              <h3 className="mb-1.5 text-[11px] font-black text-[#F2A900]">{section.title}</h3>
              <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                {section.items.map((item) => (
                  <React.Fragment key={item.term}>
                    <dt className="font-bold text-gray-200">{item.term}</dt>
                    <dd className="text-gray-400">{item.text}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
