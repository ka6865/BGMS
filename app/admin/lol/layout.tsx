import type { Metadata } from "next";
import { requireLolDevPageAdmin } from "@/lib/lol/access.server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "LoL 비공개 개발" },
  robots: { index: false, follow: false },
};

export default async function LolDevLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactNode> {
  await requireLolDevPageAdmin();
  return children;
}
