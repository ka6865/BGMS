"use client";

import React from "react";
import Link from "next/link";

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer
      style={{
        width: "100%",
        backgroundColor: "var(--color-bg-surface, #161616)",
        borderTop: "1px solid var(--color-border, rgba(255,255,255,0.08))",
        paddingTop: "32px",
        paddingBottom: "24px",
        marginTop: "auto",
        position: "relative",
        zIndex: 60,
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 24px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "16px",
        }}
      >
        {/* 브랜드 */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "22px",
              fontWeight: 900,
              letterSpacing: "-1px",
              fontStyle: "italic",
              color: "white",
            }}
          >
            BG
            <span style={{ color: "var(--color-accent, #F2A900)" }}>MS</span>
          </span>
          <span
            style={{
              fontSize: "10px",
              fontWeight: 600,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.25)",
              paddingLeft: "8px",
              borderLeft: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            BATTLEGROUNDS MAP SYSTEM
          </span>
        </div>

        {/* 링크 */}
        <div
          style={{
            display: "flex",
            gap: "20px",
            alignItems: "center",
          }}
        >
          <a
            href="https://discord.gg/T97MR78awb"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "12px",
              fontWeight: 600,
              color: "#5865F2",
              textDecoration: "none",
              transition: "opacity 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.7")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "1")}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
            </svg>
            Discord
          </a>

          <span style={{ width: "1px", height: "14px", backgroundColor: "rgba(255,255,255,0.1)" }} />

          <Link
            href="/board"
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.35)",
              textDecoration: "none",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.7)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.35)")}
          >
            커뮤니티
          </Link>

          <span style={{ width: "1px", height: "14px", backgroundColor: "rgba(255,255,255,0.1)" }} />

          <Link
            href="/weapons"
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.35)",
              textDecoration: "none",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.7)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.35)")}
          >
            무기 도감
          </Link>

          <span style={{ width: "1px", height: "14px", backgroundColor: "rgba(255,255,255,0.1)" }} />

          <Link
            href="/privacy"
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.35)",
              textDecoration: "none",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.7)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.35)")}
          >
            개인정보처리방침
          </Link>

          <span style={{ width: "1px", height: "14px", backgroundColor: "rgba(255,255,255,0.1)" }} />

          <Link
            href="/terms"
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.35)",
              textDecoration: "none",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.7)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(255,255,255,0.35)")}
          >
            이용약관
          </Link>
        </div>

        {/* 법적 고지 */}
        <p
          style={{
            fontSize: "11px",
            color: "rgba(255,255,255,0.2)",
            lineHeight: 1.6,
            textAlign: "center",
            maxWidth: "600px",
            margin: 0,
          }}
        >
          BGMS는 배틀그라운드 팬들을 위한 비공식 서비스이며, KRAFTON 및 PUBG Corporation과 제휴, 후원, 보증 관계가 아닙니다.
          PUBG, PLAYERUNKNOWN&apos;S BATTLEGROUNDS and all related logos are trademarks of PUBG Corporation or its affiliates.
        </p>

        {/* 카피라이트 */}
        <div
          style={{
            fontSize: "10px",
            color: "rgba(255,255,255,0.12)",
            fontWeight: 500,
            letterSpacing: "0.05em",
          }}
        >
          © {currentYear} BGMS Team · All Rights Reserved
        </div>
      </div>
    </footer>
  );
};

export default Footer;
