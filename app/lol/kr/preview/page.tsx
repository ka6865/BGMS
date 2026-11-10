import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { hasLolRiotAccess, LOL_PREVIEW_COOKIE, lolPreviewPasswordEnabled, safeLolPreviewNext } from "@/lib/lol/previewAccess";
import LolPreviewGate from "@/components/lol/LolPreviewGate";

export const metadata: Metadata = { title: { absolute: "BGMS | LoL 개발 중" } };

// proxy.ts가 잠긴 LoL 경로를 이 화면으로 rewrite한다. next는 원래 요청 경로다.
export default async function LolPreviewPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  requireLolPublicPage();
  const next = safeLolPreviewNext((await searchParams).next);
  if (hasLolRiotAccess((await cookies()).get(LOL_PREVIEW_COOKIE)?.value)) redirect(next);
  return <LolPreviewGate next={next} passwordEnabled={lolPreviewPasswordEnabled()} />;
}
