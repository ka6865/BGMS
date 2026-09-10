import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "node-html-parser";
import sharp from "sharp";
import dotenv from "dotenv";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import catalog from "../data/crates/pubg-43-1.json";
import { normalizeCrateItemName } from "../lib/crates/assetMapping";

type Item = (typeof catalog.crates)[number]["items"][number];
export const itemKey = (item: Item) =>
  `pubgitems_${item.imageId}${item.name.endsWith(" 도안") ? "_imprint" : ""}_x${item.quantity}`;
const imageKey = (id: string) => `crates/pubgitems-${id}.webp`;
const imageUrl = (id: string) => `/api/images/crates/pubgitems-${id}.webp`;
const sqlValue = (value: string | number | boolean | null) =>
  value === null ? "NULL" : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);

export function validateCatalog() {
  const assets = new Map<string, string>();
  for (const crate of catalog.crates) {
    if (Math.abs(crate.items.reduce((sum, item) => sum + item.probability, 0) - 1) > 1e-10) {
      throw new Error(`${crate.name}: probability total must be 100%`);
    }
    const keys = new Set<string>();
    for (const item of crate.items) {
      if (!(item.probability > 0 && item.probability <= 1) || !Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new Error(`Invalid item: ${item.name}`);
      }
      if (!(item.imageId in catalog.images)) throw new Error(`Missing image: ${item.name}`);
      const key = itemKey(item);
      if (keys.has(key)) throw new Error(`Duplicate outcome: ${crate.name}/${key}`);
      keys.add(key);
      const identity = JSON.stringify([item.name, item.rarity, item.quantity]);
      if (assets.has(key) && assets.get(key) !== identity) throw new Error(`Conflicting asset: ${key}`);
      assets.set(key, identity);
    }
  }
}

/** Compare every row, including guaranteed rewards, against the supplied official HTML. */
export function verifyOfficialHtml(html: string) {
  const root = parse(html);
  let heading = "";
  const tables = new Map<string, ReturnType<typeof parse>>();
  for (const element of root.querySelectorAll("h2,h3,h4,table")) {
    if (element.tagName === "TABLE") tables.set(heading, element);
    else heading = element.text.trim();
  }
  for (const crate of catalog.crates) {
    const table = tables.get(crate.name);
    if (!table) throw new Error(`Missing official table: ${crate.name}`);
    const rows = table.querySelectorAll("tr").slice(1, -1);
    if (rows.length !== crate.items.length) throw new Error(`Official row count changed: ${crate.name}`);
    rows.forEach((row, index) => {
      const cells = row.querySelectorAll("td").map(cell =>
        cell.innerHTML.split(/<hr\b[^>]*>/i).map(part => parse(part).text.trim()),
      );
      const item = crate.items[index];
      const rarities: Record<string, string> = { "얼티밋": "ULTIMATE", "레전더리": "LEGENDARY", "에픽": "EPIC", "엘리트": "ELITE", "레어": "RARE", "스페셜": "SPECIAL", "-": "COMMON" };
      if (cells[0]?.[0] !== item.name || rarities[cells[1]?.[0]] !== item.rarity ||
          Number(cells[2]?.[0]) !== item.quantity ||
          Math.abs(parseFloat(cells[3]?.[0]) / 100 - item.probability) > 1e-12 ||
          cells[0]?.[1] !== crate.bonusCurrency || Number(cells[2]?.[1]) !== crate.bonusQuantity) {
        throw new Error(`Official row mismatch: ${crate.name}/${item.name}`);
      }
    });
  }
}

export function buildCatalogSql() {
  validateCatalog();
  const assets = new Map<string, Item>();
  catalog.crates.forEach(crate => crate.items.forEach(item => assets.set(itemKey(item), item)));
  const assetRows = [...assets].map(([key, item]) => {
    const name = item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name;
    return `(${[key, name, normalizeCrateItemName(name), imageKey(item.imageId), imageUrl(item.imageId), item.rarity].map(sqlValue).join(", ")})`;
  });
  // Existing templates retain their purchase settings. This import changes their content and rewards only.
  const templateRows = catalog.crates.map(crate => {
    const contraband = crate.type === "contraband";
    const bonusCode = contraband ? "contraband_scrap" : crate.imageId === "14300064" ? "jujutsu_token" : "artisan_token";
    return `(${[crate.id, crate.name, crate.type, contraband ? 200 : 250, contraband ? 1800 : 2500,
      crate.imageId, normalizeCrateItemName(crate.name), imageKey(crate.imageId), imageUrl(crate.imageId),
      `PUBG #43.1 공식 확률표 기준 · ${crate.items.length}종 · 개봉당 ${crate.bonusCurrency} ${crate.bonusQuantity}개`,
      true, contraband ? "contraband_coupon" : null, contraband ? 10 : null, contraband ? 100 : null,
      bonusCode, crate.bonusQuantity, crate.bonusQuantity * 10].map(sqlValue).join(", ")})`;
  });
  const relationRows = catalog.crates.flatMap(crate => crate.items.map(item =>
    `(${sqlValue(crate.id)}::uuid, ${sqlValue(itemKey(item))}, ${item.probability.toFixed(6)})`,
  ));
  return `-- PUBG #43.1: ${catalog.sourceUrl}
-- Images: https://pubgitems.info/ko (source URLs are recorded in data/crates/pubg-43-1.json).
-- Upload the verified images with scripts/sync_crates_43_1.ts --upload-images before applying.
BEGIN;
INSERT INTO public.crate_item_assets (asset_key, display_name, normalized_name, r2_key, image_url, rarity) VALUES
${assetRows.join(",\n")}
ON CONFLICT (asset_key) DO UPDATE SET display_name=EXCLUDED.display_name, normalized_name=EXCLUDED.normalized_name,
  r2_key=EXCLUDED.r2_key, image_url=EXCLUDED.image_url, rarity=EXCLUDED.rarity;

INSERT INTO public.crate_templates (id, name, type, price_gcoin, bundle_price_gcoin, asset_key, normalized_name,
  r2_key, image_url, description, active, ticket_currency_code, ticket_price_single, ticket_price_bundle,
  bonus_currency_code, bonus_amount_single, bonus_amount_bundle) VALUES
${templateRows.join(",\n")}
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, asset_key=EXCLUDED.asset_key,
  normalized_name=EXCLUDED.normalized_name, r2_key=EXCLUDED.r2_key, image_url=EXCLUDED.image_url,
  description=EXCLUDED.description, bonus_currency_code=EXCLUDED.bonus_currency_code,
  bonus_amount_single=EXCLUDED.bonus_amount_single, bonus_amount_bundle=EXCLUDED.bonus_amount_bundle;

CREATE TEMP TABLE crate_43_1_outcomes (crate_id uuid, asset_key text, probability numeric) ON COMMIT DROP;
INSERT INTO crate_43_1_outcomes VALUES
${relationRows.join(",\n")};

-- Replace only obsolete BASE mappings of the six specified templates; preserve other crates and bonus/prime pools.
DELETE FROM public.crate_item_relations r
WHERE r.drop_type='base' AND r.crate_template_id IN (SELECT crate_id FROM crate_43_1_outcomes)
AND NOT EXISTS (SELECT 1 FROM crate_43_1_outcomes o JOIN public.crate_item_assets a ON a.asset_key=o.asset_key
  WHERE o.crate_id=r.crate_template_id AND a.id=r.asset_id);

INSERT INTO public.crate_item_relations (crate_template_id, asset_id, drop_type, probability, token_count, is_prime_parcel, is_extra_crate)
SELECT o.crate_id, a.id, 'base', o.probability, 0, false, false
FROM crate_43_1_outcomes o JOIN public.crate_item_assets a ON a.asset_key=o.asset_key
ON CONFLICT (crate_template_id, asset_id, drop_type) DO UPDATE SET probability=EXCLUDED.probability,
  token_count=0, is_prime_parcel=false, is_extra_crate=false;

DO $$ BEGIN
  IF EXISTS (SELECT o.crate_id FROM (SELECT DISTINCT crate_id FROM crate_43_1_outcomes) o
    LEFT JOIN public.crate_item_relations r ON r.crate_template_id=o.crate_id AND r.drop_type='base'
    GROUP BY o.crate_id HAVING sum(r.probability) IS DISTINCT FROM 1::numeric
    OR count(r.id) <> (SELECT count(*) FROM crate_43_1_outcomes e WHERE e.crate_id=o.crate_id)) THEN
    RAISE EXCEPTION 'Crate import failed: invalid outcome count or probability total';
  END IF;
END $$;
COMMIT;
`;
}

async function uploadImages() {
  dotenv.config({ path: ".env.local", quiet: true });
  for (const key of ["CLOUDFLARE_R2_ENDPOINT", "CLOUDFLARE_R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_BUCKET_NAME"]) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  const client = new S3Client({ region: "auto", endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
    credentials: { accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! }, forcePathStyle: true });
  const entries = Object.entries(catalog.images);
  let index = 0, uploaded = 0, bytes = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < entries.length) {
      const [id, source] = entries[index++];
      const target = { Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME!, Key: imageKey(id) };
      try {
        await client.send(new HeadObjectCommand(target));
        continue;
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      }
      const response = await fetch(source.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Image ${id}: HTTP ${response.status}`);
      const buffer = await sharp(Buffer.from(await response.arrayBuffer()))
        .resize(256, 256, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
      await client.send(new PutObjectCommand({ ...target, Body: buffer, ContentType: "image/webp", CacheControl: "public, max-age=31536000, immutable" }));
      uploaded++; bytes += buffer.length;
      if (uploaded % 50 === 0) console.log(`Uploaded ${uploaded}/${entries.length} images`);
    }
  }));
  console.log(JSON.stringify({ verified: entries.length, uploaded, bytes }));
}

async function main() {
  validateCatalog();
  const args = process.argv.slice(2);
  const officialIndex = args.indexOf("--verify-official");
  if (officialIndex >= 0) verifyOfficialHtml(await fs.readFile(args[officialIndex + 1], "utf8"));
  const sqlIndex = args.indexOf("--write-sql");
  if (sqlIndex >= 0) await fs.writeFile(args[sqlIndex + 1], buildCatalogSql());
  if (args.includes("--upload-images")) await uploadImages();
  console.table(catalog.crates.map(crate => ({ name: crate.name, outcomes: crate.items.length,
    total: Number(crate.items.reduce((sum, item) => sum + item.probability, 0).toFixed(6)) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
