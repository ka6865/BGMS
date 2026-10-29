import AdminNav from "@/components/admin/AdminNav";

/**
 * 관리자 화면 공통 레이아웃.
 * 권한 확인은 각 화면과 API가 계속 담당하고, 이 레이아웃은 메뉴와 스크롤 영역만 제공한다.
 * LoL 개발 화면은 LOL_DEV_ENABLED가 꺼져 있으면 404이므로 켜진 환경에서만 메뉴에 노출한다.
 */
export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const showLol = process.env.LOL_DEV_ENABLED === "true";
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-zinc-950">
      <AdminNav showLol={showLol} />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
