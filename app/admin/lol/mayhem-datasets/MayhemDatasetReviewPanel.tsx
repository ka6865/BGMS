"use client";

import { useState } from "react";
import LolMayhemUpdateSummary from "@/components/lol/LolMayhemUpdateSummary";
import LolMayhemComboMapping from "@/components/lol/LolMayhemComboMapping";

export default function MayhemDatasetReviewPanel() {
  const [mappingOpen, setMappingOpen] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  return <main className="mx-auto w-full max-w-5xl space-y-5 p-4 text-zinc-100 sm:p-6" data-testid="mayhem-dataset-review">
    <header><h1 className="text-xl font-semibold">증바람 데이터 관리</h1></header>
    <LolMayhemUpdateSummary refreshVersion={refreshVersion} onOpenMapping={() => { setMappingOpen(true); requestAnimationFrame(() => document.getElementById("mayhem-mapping")?.scrollIntoView({ block: "start" })); }} />
    <details id="mayhem-mapping" open={mappingOpen} className="border-t border-zinc-800 pt-2" onToggle={event => setMappingOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer content-center text-sm">증강 이름 연결</summary>
      {mappingOpen && <LolMayhemComboMapping onPrepared={() => setRefreshVersion(version => version + 1)} />}
    </details>
  </main>;
}
