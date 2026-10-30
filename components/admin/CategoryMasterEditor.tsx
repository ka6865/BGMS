"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import ConfirmModal from "@/components/common/ConfirmModal";
import { ICON_LIBRARY } from "@/lib/map_config";
import {
  getAllCategories,
  upsertCategory,
  deactivateCategory,
  activateCategory,
} from "@/app/actions/map-settings";
import type { CategoryRow } from "@/types/map-settings";

const COLORS_PRESET = [
  "#ef4444", "#f97316", "#eab308", "#84cc16", "#10b981",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#a855f7", "#ec4899",
  "#d8b4fe", "#0ea5e9", "#64748b", "#F2A900", "#ffffff",
];

interface CategoryMasterEditorProps {
  onRefresh?: () => void;
}

export default function CategoryMasterEditor({ onRefresh }: CategoryMasterEditorProps) {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddMode, setIsAddMode] = useState(false);

  // 편집 폼 상태
  const [formLabel, setFormLabel] = useState("");
  const [formColor, setFormColor] = useState("#F2A900");
  const [formIconId, setFormIconId] = useState("car");
  const [formSortOrder, setFormSortOrder] = useState(0);

  const [isDeactivateConfirmOpen, setIsDeactivateConfirmOpen] = useState(false);
  const [deactivateTargetCategory, setDeactivateTargetCategory] = useState<CategoryRow | null>(null);

  const loadCategories = useCallback(async () => {
    const data = await getAllCategories();
    setCategories(data);
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const startEdit = (cat: CategoryRow) => {
    setIsAddMode(false);
    setEditingId(cat.id);
    setFormLabel(cat.label);
    setFormColor(cat.color);
    setFormIconId(cat.icon_id);
    setFormSortOrder(cat.sort_order);
  };

  const startAdd = () => {
    setEditingId(null);
    setIsAddMode(true);
    setFormLabel("");
    setFormColor("#F2A900");
    setFormIconId("car");
    setFormSortOrder((categories.length + 1) * 10);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsAddMode(false);
  };

  const handleSave = async () => {
    if (!formLabel.trim()) {
      toast.error("카테고리 이름을 입력해 주세요.");
      return;
    }

    setIsSaving(true);
    try {
      let id: string;
      if (isAddMode) {
        // 새 ID 자동 생성 (타임스탬프 기반)
        const base = formLabel.replace(/\s+/g, "").replace(/[^a-zA-Z0-9가-힣]/g, "");
        id = `Cat_${base}_${Date.now()}`;
      } else {
        id = editingId!;
      }

      await upsertCategory({
        id,
        label: formLabel.trim(),
        color: formColor,
        icon_id: formIconId,
        is_active: true,
        sort_order: formSortOrder,
      });

      toast.success(isAddMode ? "카테고리가 추가되었습니다." : "카테고리가 수정되었습니다.");
      await loadCategories();
      cancelEdit();
      onRefresh?.();
    } catch (err: any) {
      toast.error("저장 실패: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeactivate = (cat: CategoryRow) => {
    setDeactivateTargetCategory(cat);
    setIsDeactivateConfirmOpen(true);
  };

  const executeDeactivate = async () => {
    if (!deactivateTargetCategory) return;
    const cat = deactivateTargetCategory;
    setIsDeactivateConfirmOpen(false);
    try {
      await deactivateCategory(cat.id);
      toast.success(`'${cat.label}' 카테고리가 숨겨졌습니다.`);
      await loadCategories();
      onRefresh?.();
    } catch (err: any) {
      toast.error("처리 실패: " + err.message);
    } finally {
      setDeactivateTargetCategory(null);
    }
  };

  const handleActivate = async (cat: CategoryRow) => {
    try {
      await activateCategory(cat.id);
      toast.success(`'${cat.label}' 카테고리가 활성화되었습니다.`);
      await loadCategories();
      onRefresh?.();
    } catch (err: any) {
      toast.error("처리 실패: " + err.message);
    }
  };

  const activeList = categories.filter((c) => c.is_active);
  const inactiveList = categories.filter((c) => !c.is_active);

  return (
    <div className="max-w-[900px] mx-auto">
      {/* 헤더 */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-black text-white sm:text-2xl">카테고리 마스터 관리</h2>
          <p className="mt-1 text-xs text-gray-500 sm:text-sm">아이콘, 색상, 이름을 수정하거나 새 카테고리를 추가하세요.</p>
        </div>
        <button
          type="button"
          onClick={startAdd}
          className="min-h-11 w-full rounded-lg bg-[#F2A900] px-5 text-sm font-black text-black transition-colors hover:bg-[#cc8b00] sm:w-auto"
        >
          + 새 카테고리 추가
        </button>
      </div>

      {/* 새 카테고리 추가 / 편집 폼 */}
      {(isAddMode || editingId) && (
        <div className="mb-6 rounded-xl border-2 border-[#F2A900]/50 bg-[#1a1a1a] p-4 sm:p-6">
          <h3 className="text-lg font-black text-[#F2A900] mb-5">
            {isAddMode ? "새 카테고리 추가" : `'${categories.find(c => c.id === editingId)?.label}' 수정`}
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* 이름 */}
            <div className="md:col-span-1">
              <label htmlFor="category-form-label" className="block text-xs font-bold text-gray-500 mb-2">카테고리 이름 *</label>
              <input
                id="category-form-label"
                type="text"
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder="예) 에어보트, 트럭 등"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#F2A900]"
              />
            </div>

            {/* 정렬 순서 */}
            <div className="md:col-span-1">
              <label htmlFor="category-form-sort-order" className="block text-xs font-bold text-gray-500 mb-2">표시 순서 (숫자가 작을수록 앞)</label>
              <input
                id="category-form-sort-order"
                type="number"
                value={formSortOrder}
                onChange={(e) => setFormSortOrder(Number(e.target.value))}
                className="w-full bg-[#111] border border-[#333] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#F2A900]"
              />
            </div>

            {/* 아이콘 선택 라이브러리 */}
            <div className="md:col-span-2">
              <p id="category-form-icon-label" className="block text-xs font-bold text-gray-500 mb-2">아이콘 선택</p>
              <div role="group" aria-labelledby="category-form-icon-label" className="flex gap-2 flex-wrap sm:gap-3">
                {Object.entries(ICON_LIBRARY).map(([id, icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFormIconId(id)}
                    aria-pressed={formIconId === id}
                    className={`flex w-[76px] flex-col items-center gap-1.5 rounded-xl border-2 p-2.5 transition-colors ${
                      formIconId === id
                        ? "border-[#F2A900] bg-[#F2A900]/10"
                        : "border-[#333] bg-[#111] hover:border-gray-500"
                    }`}
                  >
                    {/* 아이콘 미리보기 */}
                    <svg
                      viewBox="0 0 24 24"
                      width="28"
                      height="28"
                      fill={formIconId === id ? formColor : "#666"}
                    >
                      <path d={icon.path} />
                    </svg>
                    <span className="text-xs text-gray-400 font-bold">{icon.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 색상 선택 */}
            <div className="md:col-span-2">
              <p id="category-form-color-label" className="block text-xs font-bold text-gray-500 mb-2">마커 색상</p>
              <div role="group" aria-labelledby="category-form-color-label" className="flex items-center gap-2 flex-wrap sm:gap-3">
                {/* 프리셋 색상들 */}
                {COLORS_PRESET.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setFormColor(c)}
                    aria-label={`마커 색상 ${c}`}
                    aria-pressed={formColor === c}
                    className={`h-9 w-9 rounded-full border-2 transition-colors ${
                      formColor === c ? "border-white ring-2 ring-white/40" : "border-transparent hover:border-gray-500"
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
                {/* 직접 입력 컬러피커 */}
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={formColor}
                    onChange={(e) => setFormColor(e.target.value)}
                    className="w-10 h-10 rounded-lg cursor-pointer border-0 bg-transparent"
                    title="직접 선택"
                    aria-label="마커 색상 직접 선택"
                  />
                  <span className="text-xs text-gray-500 font-mono">{formColor}</span>
                </div>
              </div>
              {/* 미리보기 */}
              <div className="mt-4 flex items-center gap-3">
                <span className="text-xs text-gray-500">미리보기:</span>
                <div
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border"
                  style={{ borderColor: formColor, backgroundColor: formColor + '15' }}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill={formColor}>
                    <path d={ICON_LIBRARY[formIconId]?.path} />
                  </svg>
                  <span className="text-sm font-bold" style={{ color: formColor }}>
                    {formLabel || "카테고리 이름"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className={`min-h-11 px-6 rounded-xl font-black text-sm transition-colors ${
                isSaving
                  ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                  : "bg-[#F2A900] text-black hover:bg-[#cc8b00] active:scale-95"
              }`}
            >
              {isSaving ? "저장 중..." : "저장하기"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="min-h-11 px-6 rounded-xl font-bold text-sm text-gray-400 hover:text-white bg-[#222] hover:bg-[#333] transition-all"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 활성 카테고리 목록 */}
      <div className="mb-6">
        <h3 className="text-sm font-black text-gray-500 uppercase tracking-widest mb-3">활성화된 카테고리 ({activeList.length})</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {activeList.map((cat) => {
            const icon = ICON_LIBRARY[cat.icon_id];
            return (
              <div
                key={cat.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-all ${
                  editingId === cat.id
                    ? "border-[#F2A900] bg-[#F2A900]/5"
                    : "border-[#333] bg-[#141414] hover:border-gray-600"
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div
                    className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center"
                    style={{ backgroundColor: cat.color + '22' }}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill={cat.color}>
                      <path d={icon?.path || ICON_LIBRARY.car.path} />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="break-words font-bold text-white text-sm">{cat.label}</div>
                    <div className="break-all text-xs text-gray-500 font-mono">{cat.id}</div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => startEdit(cat)}
                    aria-label={`${cat.label} 수정`}
                    className="min-h-11 px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-white bg-[#222] hover:bg-[#333] rounded-lg transition-all"
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeactivate(cat)}
                    aria-label={`${cat.label} 숨김`}
                    className="min-h-11 px-3 py-1.5 text-xs font-bold text-red-500/70 hover:text-red-400 bg-red-500/5 hover:bg-red-500/10 rounded-lg transition-all"
                  >
                    숨김
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 비활성 카테고리 목록 */}
      {inactiveList.length > 0 && (
        <div className="mt-8 pt-8 border-t border-[#222]">
          <h3 className="text-sm font-black text-gray-600 uppercase tracking-widest mb-3">
            숨김 처리된 카테고리 ({inactiveList.length}) — 기존 마커는 DB에 유지 중
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {inactiveList.map((cat) => {
              const icon = ICON_LIBRARY[cat.icon_id];
              return (
                <div
                  key={cat.id}
                  className="flex items-center justify-between p-4 rounded-xl border border-[#222] bg-[#0f0f0f] opacity-60"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-[#222] flex items-center justify-center">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="#555">
                        <path d={icon?.path || ICON_LIBRARY.car.path} />
                      </svg>
                    </div>
                    <div>
                      <div className="font-bold text-gray-500 text-sm line-through">{cat.label}</div>
                      <div className="text-[10px] text-gray-700 font-mono">{cat.id}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleActivate(cat)}
                    aria-label={`${cat.label} 복구`}
                    className="min-h-11 shrink-0 px-3 py-1.5 text-xs font-bold text-green-500/80 hover:text-green-400 bg-green-500/5 hover:bg-green-500/10 rounded-lg transition-all"
                  >
                    복구
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* 카테고리 숨김 확인 모달 */}
      <ConfirmModal
        isOpen={isDeactivateConfirmOpen}
        title="카테고리 숨김"
        description={deactivateTargetCategory ? `'${deactivateTargetCategory.label}' 카테고리를 숨김 처리하시겠습니까?\n기존 마커는 DB에 유지됩니다.` : ""}
        confirmText="숨김"
        cancelText="취소"
        type="warning"
        onConfirm={executeDeactivate}
        onCancel={() => {
          setIsDeactivateConfirmOpen(false);
          setDeactivateTargetCategory(null);
        }}
      />
    </div>
  );
}
