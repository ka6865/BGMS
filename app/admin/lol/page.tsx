import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

export default async function LolDevPage(): Promise<React.ReactNode> {
  await requireLolDevPageAdmin();
  return <LolSearchPanel />;
}
