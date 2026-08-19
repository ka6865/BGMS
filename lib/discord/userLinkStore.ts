import { createClient } from "@supabase/supabase-js";
import { canonicalizeLinkedPlayerPlatform } from "@/lib/pubg/linkedPlayerSync";

export interface DiscordUserLink {
  discord_user_id: string;
  pubg_nickname: string;
  pubg_platform: string;
  created_at: string;
  updated_at: string;
}

export type SupabaseLikeClient = {
  from(table: string): {
    select(columns?: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): Promise<{ data: any; error: any }>;
      };
    };
    upsert(values: any, options?: any): {
      select(columns?: string): {
        single(): Promise<{ data: any; error: any }>;
      };
    };
  };
};

function getServiceClient(): SupabaseLikeClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("discord-user-link-service-role-credentials-missing");
  }
  return createClient(url, key) as unknown as SupabaseLikeClient;
}

export async function getDiscordUserLink(
  discordUserId: string,
  client?: SupabaseLikeClient,
): Promise<DiscordUserLink | null> {
  const supabase = client ?? getServiceClient();
  const { data, error } = await supabase
    .from("discord_user_links")
    .select("discord_user_id, pubg_nickname, pubg_platform, created_at, updated_at")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (error) {
    throw new Error(`discord-user-link-fetch-failed: ${error.message || error}`);
  }
  return data || null;
}

export async function setDiscordUserLink(
  discordUserId: string,
  pubgNickname: string,
  pubgPlatform: string = "steam",
  client?: SupabaseLikeClient,
): Promise<DiscordUserLink> {
  const supabase = client ?? getServiceClient();
  const trimmedNickname = pubgNickname.trim();
  if (!trimmedNickname) {
    throw new Error("discord-user-link-nickname-empty");
  }

  const platform = canonicalizeLinkedPlayerPlatform(pubgPlatform);

  const { data, error } = await supabase
    .from("discord_user_links")
    .upsert(
      {
        discord_user_id: discordUserId,
        pubg_nickname: trimmedNickname,
        pubg_platform: platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "discord_user_id" },
    )
    .select("discord_user_id, pubg_nickname, pubg_platform, created_at, updated_at")
    .single();

  if (error || !data) {
    throw new Error(`discord-user-link-upsert-failed: ${error?.message || "unknown error"}`);
  }
  return data;
}

