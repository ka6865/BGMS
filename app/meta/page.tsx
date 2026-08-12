import { Metadata } from "next";
import WeaponMetaDashboard from "@/components/meta/WeaponMetaDashboard";

export const metadata: Metadata = {
  title: "실시간 총기 메타 동향 | BGMS",
  description: "PUBG 실시간 패치 총기 픽률, K/D, 교전 효율성 및 LMG 메타 동향 리포트",
};

export default function MetaPage() {
  return (
    <main className="min-h-screen bg-[#070a13] p-4 sm:p-6 pb-20">
      <div className="mx-auto max-w-[1200px] space-y-6">
        <WeaponMetaDashboard />
      </div>
    </main>
  );
}
