import { parseArgs } from "node:util";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier,context,nextResolve){return specifier==='server-only'?{url:'data:text/javascript,export {}',shortCircuit:true}:nextResolve(specifier,context);}`), import.meta.url);
try {
  const { values } = parseArgs({ options: { kind: { type: "string" }, "dry-run": { type: "boolean" } } });
  if (values.kind !== "combos" && values.kind !== "champions" && values.kind !== "references") throw new Error("auto_publish_kind_invalid");
  const { autoPublishMayhem } = await import("../lib/lol/mayhemAutoPublish.server");
  const result = await autoPublishMayhem(values.kind, { dryRun: values["dry-run"] === true });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures) process.exitCode = 1;
} catch (error) {
  console.error("[lol-mayhem-auto-publish]", error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "auto_publish_failed");
  process.exitCode = 1;
}
