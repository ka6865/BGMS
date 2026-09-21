import { redirect } from "next/navigation";
import TicketThread from "@/components/support/TicketThread";
import { createClient } from "@/utils/supabase/server";

export default async function SupportTicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/support`);
  const { ticketId } = await params;
  return <TicketThread ticketId={ticketId} />;
}
