import { parseArgs } from "node:util";
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier, context, nextResolve) {
  return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : nextResolve(specifier, context);
}`), import.meta.url);

try {
  const { values } = parseArgs({ options: { apply: { type: "boolean" }, "dry-run": { type: "boolean" }, patch: { type: "string" } } });
  if (values.apply && values["dry-run"]) throw new Error("conflicting_mode");
  const { ingestMayhemDataset } = await import("../lib/lol/mayhemIngest.server");
  console.log(JSON.stringify(await ingestMayhemDataset({ apply: values.apply === true, patch: values.patch }), null, 2));
} catch (error) {
  console.error("[lol-mayhem]", error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "dataset_sync_failed");
  process.exitCode = 1;
}
