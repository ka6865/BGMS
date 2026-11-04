import { parseArgs } from "node:util";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier,context,nextResolve){return specifier==='server-only'?{url:'data:text/javascript,export {}',shortCircuit:true}:nextResolve(specifier,context);}`), import.meta.url);
try {
  const { values } = parseArgs({ options: { apply: { type: "boolean" }, "dry-run": { type: "boolean" }, check: { type: "boolean" }, kind: { type: "string" } } });
  if ([values.apply, values["dry-run"], values.check].filter(Boolean).length > 1) throw new Error("conflicting_mode");
  const { validReferenceKind } = await import("../lib/lol/mayhemReference");
  if (values.kind && !validReferenceKind(values.kind)) throw new Error("reference_kind_invalid");
  if (values.check) {
    const { referencePersistenceEnabled, referencePublicEnabled } = await import("../lib/lol/mayhemReferenceStore.server");
    console.log(JSON.stringify({ enabled: referencePersistenceEnabled(), publicEnabled: referencePublicEnabled(), apiKeyConfigured: !!process.env.LOL_MAYHEM_STATS_API_KEY, databaseWrites: 0, storageWrites: 0, apiCreditsUsed: 0 }, null, 2));
  } else {
    const { ingestMayhemReferences } = await import("../lib/lol/mayhemReferenceIngest.server");
    const result = await ingestMayhemReferences({ apply: values.apply === true, ...(validReferenceKind(values.kind) ? { kinds: [values.kind] } : {}) });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "partial") process.exitCode = 1;
  }
} catch (error) {
  console.error("[lol-mayhem-reference]", error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "reference_sync_failed");
  process.exitCode = 1;
}
