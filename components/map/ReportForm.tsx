import React, { useState, useRef } from "react";
import L from "leaflet";
import { supabase } from "../../lib/supabase";
import { toast } from "sonner";
import { useMapSettings } from "@/hooks/useMapSettings";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { X } from "lucide-react";


interface ReportFormProps {
  location: L.LatLng;
  activeMapId: string;
  icons: Record<string, L.DivIcon>;
  currentUser: any;
  onClose: () => void;
}

const ReportForm = ({
  location,
  activeMapId,
  icons,
  currentUser,
  onClose,
}: ReportFormProps) => {
  const [selectedType, setSelectedType] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  // DB 기반 동적 카테고리 ID 및 표시 정보 로드
  const { activeCategories: availableCategories, categoryInfoMap } = useMapSettings(activeMapId);


  const handleSubmit = async () => {
    // 유효성 검사
    if (!currentUser?.id) {
      toast.error("로그인 정보가 유효하지 않습니다.");
      return;
    }
    if (!selectedType) {
      toast.error("제보할 종류를 선택해 주세요!");
      return;
    }
    if (isSubmittingRef.current) return;

    isSubmittingRef.current = true;
    setIsSubmitting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch("/api/report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ mapName: activeMapId, markerType: selectedType, x: location.lng, y: location.lat }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error("제보 저장 실패");

      if (result.nearby) {
        toast.warning(
          "근처 20m 내에 동일한 차량 제보가 있습니다! 기존 마커의 교차 검증에 참여해 주세요.",
          { duration: 5000 }
        );
      } else {
        toast.success("새로운 제보가 접수되었습니다!");
      }
      sessionStorage.setItem("showPendingReports", "true");
      setTimeout(() => window.location.reload(), result.nearby ? 1500 : 1000);

      onClose();
    } catch (error: any) {
      console.error("최종 에러 포착:", error);
      toast.error("제보 내용을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        width: "300px",
        backgroundColor: "#1f2937",
        color: "#ffffff",
        borderRadius: "12px",
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "sans-serif",
        border: "1px solid #374151",
      }}
    >
      <div
        style={{
          backgroundColor: "#111827",
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #374151",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: "16px",
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <InlineIconLabel icon="message" iconSize={18}>차량 위치 제보</InlineIconLabel>
        </h3>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            background: "none",
            border: "none",
            color: "#9ca3af",
            fontSize: "16px",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div
        style={{
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div
          style={{
            backgroundColor: "#111827",
            padding: "8px 12px",
            borderRadius: "6px",
            fontSize: "12px",
            color: "#d1d5db",
            border: "1px solid #374151",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            <InlineIconLabel icon="map" iconSize={13}><b>{activeMapId}</b></InlineIconLabel>
          </span>
          <span>
            <InlineIconLabel icon="mapPin" iconSize={13}>{location.lng.toFixed(1)}, {location.lat.toFixed(1)}</InlineIconLabel>
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "8px",
            maxHeight: "180px",
            overflowY: "auto",
            paddingRight: "4px",
          }}
        >
          {availableCategories.map((categoryId) => {
            const categoryData = categoryInfoMap[categoryId];
            if (!categoryData) return null;

            const isSelected = selectedType === categoryId;

            return (
              <button
                key={categoryId}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedType(categoryId);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "12px 4px",
                  borderRadius: "8px",
                  cursor: "pointer",
                  transition: "all 0.2s",
                  backgroundColor: isSelected ? "#064e3b" : "#374151",
                  border: isSelected
                    ? "2px solid #10b981"
                    : "2px solid transparent",
                  boxShadow: isSelected
                    ? "0 0 10px rgba(16, 185, 129, 0.3)"
                    : "none",
                  transform: isSelected ? "scale(1.05)" : "scale(1)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "40px",
                    marginBottom: "4px",
                  }}
                  dangerouslySetInnerHTML={{
                    __html: (icons[categoryId]?.options.html as string) || "",
                  }}
                />
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: isSelected ? "bold" : "normal",
                    color: isSelected ? "#ffffff" : "#9ca3af",
                    textAlign: "center",
                    lineHeight: "1.2",
                    wordBreak: "keep-all",
                  }}
                >
                  {categoryData.label}
                </span>
              </button>
            );
          })}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            handleSubmit();
          }}
          disabled={!selectedType || isSubmitting}
          style={{
            width: "100%",
            padding: "12px",
            backgroundColor:
              !selectedType || isSubmitting ? "#4b5563" : "#10b981",
            color: !selectedType || isSubmitting ? "#9ca3af" : "#ffffff",
            border: "none",
            borderRadius: "8px",
            fontWeight: "bold",
            fontSize: "14px",
            cursor: !selectedType || isSubmitting ? "not-allowed" : "pointer",
            boxShadow:
              !selectedType || isSubmitting
                ? "none"
                : "0 4px 6px -1px rgba(16, 185, 129, 0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            marginTop: "4px",
          }}
        >
          <InlineIconLabel
            icon={isSubmitting ? "loader" : "mapPin"}
            iconClassName={isSubmitting ? "animate-spin" : ""}
          >
            {isSubmitting ? "전송 중..." : "이 차량으로 제보하기"}
          </InlineIconLabel>
        </button>
      </div>
    </div>
  );
};

export default ReportForm;
