import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanupExpiredSupportAttachments, SUPPORT_EVIDENCE_BUCKET } from "../lib/support/attachmentStorage.server";
import type { SupportDb } from "../lib/support/contracts";

export type SupportAttachmentCleanupMode = "dry-run" | "apply";
export type SupportAttachmentCleanupResult = { deleted: number; deferred: number };
export type SupportAttachmentCleanupAudit = { candidates: number; pending: number; terminal: number };

type CleanupDependencies = {
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  createServiceClient?: (url: string, serviceRoleKey: string) => SupabaseClient;
  now?: () => Date;
  write?: (message: string) => void;
};

export function resolveSupportAttachmentCleanupMode(args: string[]): SupportAttachmentCleanupMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) return "dry-run";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new Error("support-attachment-cleanup-invalid-arguments");
}

async function readQuery<T>(query: unknown): Promise<{ data: T; error: { message?: string } | null }> {
  return await query as { data: T; error: { message?: string } | null };
}

function asCandidateRows(value: unknown): Array<{ id: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is { id: string } => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string");
}

export async function inspectExpiredSupportAttachments(db: SupportDb, now = new Date()): Promise<SupportAttachmentCleanupAudit> {
  if (!Number.isFinite(now.getTime())) throw new Error("support-attachment-cleanup-invalid-now");
  const nowIso = now.toISOString();
  const terminalCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const pending = await readQuery<unknown>((db as any).from("support_attachments")
    .select("id")
    .is("ticket_id", null)
    .in("status", ["pending", "ready"])
    .lte("expires_at", nowIso));
  const terminal = await readQuery<unknown>((db as any).from("support_attachments")
    .select("id,support_tickets!inner(status,resolved_at)")
    .in("support_tickets.status", ["resolved", "rejected"])
    .lte("support_tickets.resolved_at", terminalCutoff));
  if (pending.error || terminal.error) throw new Error("support-attachment-cleanup-audit-failed");
  const unique = new Set([...asCandidateRows(pending.data), ...asCandidateRows(terminal.data)].map((row) => row.id));
  return { candidates: unique.size, pending: asCandidateRows(pending.data).length, terminal: asCandidateRows(terminal.data).length };
}

export async function runSupportAttachmentCleanup(dependencies: CleanupDependencies = {}): Promise<SupportAttachmentCleanupResult | SupportAttachmentCleanupAudit> {
  const env = dependencies.env ?? process.env;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) throw new Error("support-attachment-cleanup-credentials-missing");
  const createServiceClient = dependencies.createServiceClient ?? ((url, key) => createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }));
  const db = createServiceClient(supabaseUrl, serviceRoleKey) as SupportDb;
  const now = dependencies.now?.() ?? new Date();
  if (dependencies.dryRun) {
    const result = await inspectExpiredSupportAttachments(db, now);
    dependencies.write?.(`support-attachment-cleanup mode=dry-run bucket=${SUPPORT_EVIDENCE_BUCKET} candidates=${result.candidates} pending=${result.pending} terminal=${result.terminal}`);
    return result;
  }
  const result = await cleanupExpiredSupportAttachments(db, now);
  dependencies.write?.(`support-attachment-cleanup mode=apply bucket=${SUPPORT_EVIDENCE_BUCKET} deleted=${result.deleted} deferred=${result.deferred}`);
  return result;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  runSupportAttachmentCleanup({
    dryRun: resolveSupportAttachmentCleanupMode(process.argv.slice(2)) === "dry-run",
    write: (message) => process.stdout.write(`${message}\n`),
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error);
    process.stderr.write(`Support attachment cleanup failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
