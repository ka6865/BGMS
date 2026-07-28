"use client";

import { X } from "lucide-react";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { useMapSettings } from "@/hooks/useMapSettings";


interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
  mapLabel: string;
  activeMapId: string;
  filters: { [key: string]: boolean };
  toggleFilter: (id: string) => void;
  getCount: (id: string) => number;
}

export default function Sidebar({
  isOpen,
  setIsOpen,
  mapLabel,
  activeMapId,
  filters,
  toggleFilter,
  getCount,
}: SidebarProps) {
  // DB 기반 동적 취든 및 카테고리 정보 로드
  const { activeCategories: currentCategories, categoryInfoMap } = useMapSettings(activeMapId);


  return (
    <aside
      style={{
        width: "260px",
        backgroundColor: "var(--color-bg-surface, #161616)",
        borderRight: "1px solid var(--color-border, rgba(255,255,255,0.08))",
        display: isOpen ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
        zIndex: 5000,
      }}
    >
      {/* 헤더 */}
      <div
        style={{
          padding: "18px 16px",
          borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.08))",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <p
            style={{
              margin: 0,
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--color-text-muted, rgba(255,255,255,0.3))",
              marginBottom: "3px",
            }}
          >
            카테고리 필터
          </p>
          <h2
            style={{
              margin: 0,
              fontSize: "18px",
              color: "var(--color-accent, #F2A900)",
              fontWeight: 800,
              letterSpacing: "-0.5px",
            }}
          >
            {mapLabel}
          </h2>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.5)",
            cursor: "pointer",
            borderRadius: "8px",
            width: "32px",
            height: "32px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.15s ease",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.1)";
            (e.currentTarget as HTMLButtonElement).style.color = "white";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
            (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.5)";
          }}
        >
          <X size={15} strokeWidth={2.5} />
        </button>
      </div>

      {/* 필터 목록 */}
      <div
        style={{
          padding: "10px 10px",
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          overflowY: "auto",
          flexGrow: 1,
        }}
      >
        {/* 제보 진행 중 구역 */}
        <button
          onClick={() => toggleFilter("pending")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "11px 12px",
            borderRadius: "10px",
            cursor: "pointer",
            border: "none",
            width: "100%",
            textAlign: "left",
            backgroundColor: filters["pending"]
              ? "rgba(242, 169, 0, 0.1)"
              : "transparent",
            borderLeft: filters["pending"]
              ? "3px solid #F2A900"
              : "3px solid transparent",
            transition: "all 0.15s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <BgmsIcon
              name="eye"
              size={16}
              className={filters["pending"] ? "text-[#F2A900]" : "text-white/45"}
            />
            <span
              style={{
                fontSize: "13px",
                color: filters["pending"] ? "#F2A900" : "rgba(255,255,255,0.55)",
                fontWeight: filters["pending"] ? 700 : 500,
                transition: "color 0.15s ease",
              }}
            >
              제보 진행 중인 구역
            </span>
          </div>
          {/* 토글 스위치 */}
          <div
            style={{
              width: "32px",
              height: "18px",
              borderRadius: "9px",
              backgroundColor: filters["pending"] ? "#F2A900" : "rgba(255,255,255,0.15)",
              position: "relative",
              transition: "background-color 0.2s ease",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: "2px",
                left: filters["pending"] ? "16px" : "2px",
                width: "14px",
                height: "14px",
                borderRadius: "50%",
                backgroundColor: "white",
                transition: "left 0.2s ease",
                boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }}
            />
          </div>
        </button>

        <div
          style={{
            height: "1px",
            backgroundColor: "rgba(255,255,255,0.06)",
            margin: "6px 4px",
          }}
        />

        {currentCategories.map((id) => {
          const item = categoryInfoMap[id];
          if (!item) return null;
          const count = getCount(id);

          return (
            <button
              key={id}
              onClick={() => toggleFilter(id)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "11px 12px",
                borderRadius: "10px",
                cursor: "pointer",
                border: "none",
                width: "100%",
                textAlign: "left",
                backgroundColor: filters[id]
                  ? "rgba(255,255,255,0.05)"
                  : "transparent",
                borderLeft: filters[id]
                  ? `3px solid ${item.color}`
                  : "3px solid transparent",
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill={filters[id] ? item.color : "rgba(255,255,255,0.3)"}
                  style={{ flexShrink: 0, transition: "fill 0.15s ease" }}
                >
                  <path d={item.path} />
                </svg>
                <span
                  style={{
                    fontSize: "13px",
                    color: filters[id] ? "white" : "rgba(255,255,255,0.5)",
                    fontWeight: filters[id] ? 700 : 400,
                    transition: "color 0.15s ease",
                  }}
                >
                  {item.label}
                </span>
              </div>

              {/* 개수 배지 */}
              <span
                style={{
                  fontSize: "11px",
                  padding: "2px 8px",
                  borderRadius: "20px",
                  backgroundColor: filters[id] ? item.color : "rgba(255,255,255,0.08)",
                  color: filters[id] ? "#000" : "rgba(255,255,255,0.4)",
                  fontWeight: 700,
                  minWidth: "24px",
                  textAlign: "center",
                  transition: "all 0.15s ease",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 미니 푸터 (사이드바 하단) */}
      <div
        style={{
          padding: "20px 16px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          backgroundColor: "rgba(255,255,255,0.01)",
        }}
      >
        <div style={{ display: "flex", gap: "12px", marginBottom: "8px", alignItems: "center" }}>
          <a
            href="https://discord.gg/T97MR78awb"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: "11px",
              color: "#5865F2",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            Discord
          </a>
        </div>
        <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.15)", margin: 0, lineHeight: 1.5 }}>
          © 2026 BGMS Team.<br />
          All Rights Reserved.
        </p>
      </div>
    </aside>
  );
}
