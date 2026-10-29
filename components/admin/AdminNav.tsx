"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export interface AdminNavItem {
  href: string;
  label: string;
}

// 관리자 화면 공통 메뉴. 순서는 운영자가 자주 여는 화면 순서를 따른다.
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin/dashboard", label: "운영 대시보드" },
  { href: "/admin/bot", label: "AI 비서" },
  { href: "/admin/game-data", label: "데이터 관리" },
  { href: "/admin/review", label: "지도 제보 심사" },
  { href: "/admin/map-settings", label: "맵 설정" },
  { href: "/admin/support", label: "고객센터" },
  { href: "/admin/ai-coaching", label: "AI 코칭 품질" },
];

const LOL_NAV_ITEM: AdminNavItem = { href: "/admin/lol", label: "LoL 개발" };

export function getAdminNavItems(showLol: boolean): AdminNavItem[] {
  return showLol ? [...ADMIN_NAV_ITEMS, LOL_NAV_ITEM] : ADMIN_NAV_ITEMS;
}

export function isAdminNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 관리자 화면 상단 공통 내비게이션.
 * 모바일에서는 줄바꿈 대신 가로 스크롤로 넘치는 항목을 보여준다.
 */
export default function AdminNav({ showLol = false }: { showLol?: boolean }) {
  const pathname = usePathname() || "";
  const items = getAdminNavItems(showLol);
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // 좁은 화면에서 현재 화면 항목이 가로 스크롤 밖에 있으면 보이는 위치로 옮긴다.
  useEffect(() => {
    const active = activeRef.current;
    const list = active?.closest("ul");
    if (!active || !list) return;
    const left = active.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + active.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left - 8);
    }
  }, [pathname]);

  return (
    <nav
      aria-label="관리자 메뉴"
      data-testid="admin-nav"
      className="shrink-0 border-b border-zinc-800 bg-zinc-950 text-zinc-300"
    >
      <ul className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-2 py-1 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const active = isAdminNavItemActive(pathname, item.href);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                ref={active ? activeRef : undefined}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-amber-500/15 text-amber-200"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
