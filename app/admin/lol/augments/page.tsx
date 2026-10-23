import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import AugmentReviewPanel from "./AugmentReviewPanel";

export default async function AugmentReviewPage() {
  await requireLolDevPageAdmin();
  return <AugmentReviewPanel />;
}
