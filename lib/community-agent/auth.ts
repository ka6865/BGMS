import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { authorizeBearerSecret } from "@/lib/server/secretAuth";
import { withAuthGuard } from "@/utils/supabase/guard";
import { CommunityStore } from "./store";

export type Actor = { kind: "admin"; userId: string } | { kind: "worker"; userId: null };

export const COMMUNITY_BOT_EMAIL = "bgms-community-agent@users.invalid";
export const COMMUNITY_BOT_NICKNAME = "BGMS AI";
const USER_PAGE_SIZE = 200;
const MAX_USER_PAGES = 5;

type AdminClient = SupabaseClient<any, any, any>;

function requiredEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`community_config_${name.toLowerCase()}_missing`);
  return value;
}

/** Resolve the narrow worker secret first; every other caller must pass normal admin Auth/Profile checks. */
export async function resolveCommunityActor(request: Request): Promise<Actor | Response> {
  if (authorizeBearerSecret(request, ["COMMUNITY_AGENT_WORKER_SECRET"])) {
    return { kind: "worker", userId: null };
  }
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const denied = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
  if (denied) return denied;
  return { kind: "admin", userId: auth.user.id };
}

/** Create the service-role repository only after a route has authenticated its caller. */
export function createCommunityStore(): { client: AdminClient; store: CommunityStore } {
  const client = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return { client, store: new CommunityStore(client) };
}

function isReservedBot(user: User | null | undefined): user is User {
  return Boolean(
    user
    && user.email?.toLowerCase() === COMMUNITY_BOT_EMAIL
    && user.app_metadata?.community_agent === true
  );
}

async function findReservedEmail(client: AdminClient): Promise<User | null> {
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
    if (error) throw new Error("community_bot_lookup_failed");
    const users = data.users ?? [];
    const found = users.find((user) => user.email?.toLowerCase() === COMMUNITY_BOT_EMAIL);
    if (found) return found;
    if (users.length < USER_PAGE_SIZE) return null;
  }
  throw new Error("community_bot_lookup_truncated");
}

async function validProfile(client: AdminClient, userId: string): Promise<boolean> {
  const { data, error } = await (client as any)
    .from("profiles")
    .select("role,nickname")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error("community_bot_profile_lookup_failed");
  return data?.role === "user" && data?.nickname === COMMUNITY_BOT_NICKNAME;
}

export type PrepareBotResult =
  | { code: "prepared" | "reused"; userId: string }
  | { code: "conflict"; reason: "reserved_identity_conflict" | "configured_bot_invalid" | "profile_invalid" };

/** Prepare or recover the one reserved ordinary account without returning credentials or unrelated users. */
export async function prepareCommunityBot(client: AdminClient, store: CommunityStore): Promise<PrepareBotResult> {
  const policy = await store.getPolicy();
  if (policy.botUserId) {
    const { data, error } = await client.auth.admin.getUserById(policy.botUserId);
    if (error || !isReservedBot(data.user)) return { code: "conflict", reason: "configured_bot_invalid" };
    if (!await validProfile(client, data.user.id)) return { code: "conflict", reason: "profile_invalid" };
    return { code: "reused", userId: data.user.id };
  }

  let user = await findReservedEmail(client);
  let created = false;
  if (user && !isReservedBot(user)) return { code: "conflict", reason: "reserved_identity_conflict" };

  if (!user) {
    const password = randomBytes(48).toString("base64url");
    const createdResult = await client.auth.admin.createUser({
      email: COMMUNITY_BOT_EMAIL,
      password,
      email_confirm: true,
      user_metadata: { nickname: COMMUNITY_BOT_NICKNAME },
      app_metadata: { community_agent: true },
    });
    user = createdResult.data.user;
    created = Boolean(user);
    if (createdResult.error || !user) {
      user = await findReservedEmail(client);
      if (!user) throw new Error("community_bot_create_failed");
    }
    if (!isReservedBot(user)) return { code: "conflict", reason: "reserved_identity_conflict" };
  }

  if (!await validProfile(client, user.id)) return { code: "conflict", reason: "profile_invalid" };
  await store.updatePolicy({ botUserId: user.id });
  return { code: created ? "prepared" : "reused", userId: user.id };
}
