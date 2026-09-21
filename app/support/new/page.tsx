import { redirect } from "next/navigation";
import TicketForm from "@/components/support/TicketForm";
import { createClient } from "@/utils/supabase/server";

export default async function SupportNewPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/support/new");
  return <main className="mx-auto w-full max-w-3xl px-4 py-10 text-white sm:px-6"><div className="mb-6"><p className="text-xs font-bold uppercase tracking-[0.24em] text-amber-400">1:1 Support</p><h1 className="mt-2 text-3xl font-black">문의 작성</h1></div><TicketForm /></main>;
}
