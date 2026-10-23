import type { AugmentChange } from "./persistence.server";
export type AugmentAdminData = {
  runs: Array<{ id: string; client_patch: string; status: string; counts: { augments?: number }; error_code: string | null; started_at: string }>;
  patches: Array<{ client_patch: string; display_patch: string; published_at: string | null }>;
  detail: null | {
    patch: string; published: boolean; runId: string | null;
    changes: Array<AugmentChange & { id: string }>;
    notes: Array<{ url: string; published_at: string | null; added_names: string[]; removed_names: string[]; parse_status: string }>;
    augments: Array<{ platformId: number; name: string | null; rarity: string; icon: string | null; text: string; displaySource: string }>;
    warnings: string[];
  };
};
