import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import LolOpsPanel from "@/components/lol/LolOpsPanel";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

export default async function LolDevPage(): Promise<React.ReactNode> {
  await requireLolDevPageAdmin();
  return <LolSearchPanel adminTools={<LolOpsPanel />} />;
}
