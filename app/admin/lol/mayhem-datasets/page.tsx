import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import MayhemDatasetReviewPanel from "./MayhemDatasetReviewPanel";

export default async function MayhemDatasetReviewPage() {
  await requireLolDevPageAdmin();
  return <MayhemDatasetReviewPanel />;
}
