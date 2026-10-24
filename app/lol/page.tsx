import { redirect } from "next/navigation";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";

export default function LolPage() {
  requireLolPublicPage();
  redirect("/lol/kr");
}
