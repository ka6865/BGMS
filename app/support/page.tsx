import type { Metadata } from "next";
import SupportCenter from "@/components/support/SupportCenter";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = { title: "고객센터 | BGMS" };

export default async function SupportPage() {
  const supabase = await createClient();
  const [{ data: faqs }, { data: { user } }] = await Promise.all([
    supabase.from("support_faqs").select("id,category,question,answer").eq("is_published", true).order("sort_order", { ascending: true }),
    supabase.auth.getUser(),
  ]);
  return <SupportCenter faqs={faqs ?? []} isAuthenticated={Boolean(user)} />;
}
