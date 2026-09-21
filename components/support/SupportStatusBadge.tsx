"use client";

const LABELS: Record<string, string> = {
  new: "접수",
  in_progress: "처리 중",
  awaiting_user: "추가 정보 대기",
  answered: "답변 완료",
  resolved: "해결됨",
  rejected: "반려됨",
  not_required: "검증 불필요",
  pending: "검증 대기",
  verified: "검증 완료",
  additional_info: "추가 정보 필요",
};

export default function SupportStatusBadge({ value }: { value: string }) {
  return (
    <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-white/75">
      {LABELS[value] ?? value}
    </span>
  );
}
