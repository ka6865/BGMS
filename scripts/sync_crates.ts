import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "node-html-parser";
import sharp from "sharp";
import dotenv from "dotenv";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { normalizeCrateItemName } from "../lib/crates/assetMapping";

export interface CatalogItem {
  name: string;
  rarity: string;
  quantity: number;
  probability: number;
  imageId: string;
}

export interface CrateCatalog {
  sourceUrl: string;
  patch: string;
  images: Record<string, { url: string; sourceUrl: string }>;
  crates: {
    id: string;
    name: string;
    imageId: string;
    type: string;
    bonusCurrency: string;
    bonusQuantity: number;
    bonusCurrencyCode: string;
    items: CatalogItem[];
  }[];
  // 공식 확률표에서 빠져 판매가 끝난 상자. 구성품은 보존하고 노출만 끈다.
  retiredCrates?: { id: string; name: string }[];
}

export const itemKey = (item: CatalogItem) =>
  `pubgitems_${item.imageId}${item.name.endsWith(" 도안") ? "_imprint" : ""}_x${item.quantity}`;
const imageKey = (id: string) => `crates/pubgitems-${id}.webp`;
const imageUrl = (id: string) => `/api/images/crates/pubgitems-${id}.webp`;
const sqlValue = (value: string | number | boolean | null) =>
  value === null ? "NULL" : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);

export function validateCatalog(catalog: CrateCatalog) {
  const assets = new Map<string, string>();
  for (const crate of catalog.crates) {
    if (Math.abs(crate.items.reduce((sum, item) => sum + item.probability, 0) - 1) > 1e-10) {
      throw new Error(`${crate.name}: probability total must be 100%`);
    }
    if (!(crate.imageId in catalog.images)) throw new Error(`Missing image: ${crate.name}`);
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
  const activeIds = new Set(catalog.crates.map(crate => crate.id));
  for (const retired of catalog.retiredCrates ?? []) {
    if (activeIds.has(retired.id)) throw new Error(`Retired crate is still listed: ${retired.name}`);
  }
}

/** Compare every row, including guaranteed rewards, against the supplied official HTML. */
export function verifyOfficialHtml(catalog: CrateCatalog, html: string) {
  const root = parse(html);
  let heading = "";
  const tables = new Map<string, ReturnType<typeof parse>>();
  for (const element of root.querySelectorAll("h2,h3,h4,table")) {
    if (element.tagName === "TABLE") tables.set(heading, element);
    else heading = element.text.trim();
  }
  const rarities: Record<string, string> = { "얼티밋": "ULTIMATE", "레전더리": "LEGENDARY", "에픽": "EPIC", "엘리트": "ELITE", "레어": "RARE", "스페셜": "SPECIAL", "-": "COMMON" };
  for (const crate of catalog.crates) {
    const table = tables.get(crate.name);
    if (!table) throw new Error(`Missing official table: ${crate.name}`);
    const [header, ...body] = table.querySelectorAll("tr");
    // 43.2부터 "종류" 열이 추가되어 열 위치를 머리글로 찾는다.
    const columns = header.querySelectorAll("th,td").map(cell => cell.text.trim());
    const column = (label: string) => {
      const index = columns.indexOf(label);
      if (index < 0) throw new Error(`Missing official column: ${crate.name}/${label}`);
      return index;
    };
    const [nameAt, rarityAt, quantityAt, probabilityAt] = ["아이템", "등급", "획득 수량", "확률"].map(column);
    const rows = body.slice(0, -1);
    if (rows.length !== crate.items.length) throw new Error(`Official row count changed: ${crate.name}`);
    rows.forEach((row, index) => {
      const cells = row.querySelectorAll("td").map(cell =>
        cell.innerHTML.split(/<hr\b[^>]*>/i).map(part => parse(part).text.trim()),
      );
      const item = crate.items[index];
      if (cells[nameAt]?.[0] !== item.name || rarities[cells[rarityAt]?.[0]] !== item.rarity ||
          Number(cells[quantityAt]?.[0]) !== item.quantity ||
          Math.abs(parseFloat(cells[probabilityAt]?.[0]) / 100 - item.probability) > 1e-12 ||
          cells[nameAt]?.[1] !== crate.bonusCurrency || Number(cells[quantityAt]?.[1]) !== crate.bonusQuantity) {
        throw new Error(`Official row mismatch: ${crate.name}/${item.name}`);
      }
    });
  }
  for (const retired of catalog.retiredCrates ?? []) {
    if (tables.has(retired.name)) throw new Error(`Retired crate is still on the official page: ${retired.name}`);
  }
}

export function buildCatalogSql(catalog: CrateCatalog, catalogPath: string) {
  validateCatalog(catalog);
  const assets = new Map<string, CatalogItem>();
  catalog.crates.forEach(crate => crate.items.forEach(item => assets.set(itemKey(item), item)));
  const assetRows = [...assets].map(([key, item]) => {
    const name = item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name;
    return `(${[key, name, normalizeCrateItemName(name), imageKey(item.imageId), imageUrl(item.imageId), item.rarity].map(sqlValue).join(", ")})`;
  });
  // Existing templates retain their purchase settings. This import changes their content and rewards only.
  const templateRows = catalog.crates.map(crate => {
    const contraband = crate.type === "contraband";
    return `(${[crate.id, crate.name, crate.type, contraband ? 200 : 250, contraband ? 1800 : 2500,
      crate.imageId, normalizeCrateItemName(crate.name), imageKey(crate.imageId), imageUrl(crate.imageId),
      `PUBG #${catalog.patch} 공식 확률표 기준 · ${crate.items.length}종 · 개봉당 ${crate.bonusCurrency} ${crate.bonusQuantity}개`,
      true, contraband ? "contraband_coupon" : null, contraband ? 10 : null, contraband ? 100 : null,
      crate.bonusCurrencyCode, crate.bonusQuantity, crate.bonusQuantity * 10].map(sqlValue).join(", ")})`;
  });
  const relationRows = catalog.crates.flatMap(crate => crate.items.map(item =>
    `(${sqlValue(crate.id)}::uuid, ${sqlValue(itemKey(item))}, ${item.probability.toFixed(6)})`,
  ));
  const retired = catalog.retiredCrates ?? [];
  const retireSql = retired.length === 0 ? "" : `
-- Sales ended: hide the templates but keep their outcomes for history and statistics.
UPDATE public.crate_templates SET active=false
WHERE id IN (${retired.map(crate => `${sqlValue(crate.id)}::uuid`).join(", ")});
`;
  return `-- PUBG #${catalog.patch}: ${catalog.sourceUrl}
-- Images: https://pubgitems.info/ko (source URLs are recorded in ${catalogPath}).
-- Upload the verified images with scripts/sync_crates.ts --catalog ${catalogPath} --upload-images before applying.
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
${retireSql}
CREATE TEMP TABLE crate_catalog_outcomes (crate_id uuid, asset_key text, probability numeric) ON COMMIT DROP;
INSERT INTO crate_catalog_outcomes VALUES
${relationRows.join(",\n")};

-- Replace only obsolete BASE mappings of the listed templates; preserve other crates and bonus/prime pools.
DELETE FROM public.crate_item_relations r
WHERE r.drop_type='base' AND r.crate_template_id IN (SELECT crate_id FROM crate_catalog_outcomes)
AND NOT EXISTS (SELECT 1 FROM crate_catalog_outcomes o JOIN public.crate_item_assets a ON a.asset_key=o.asset_key
  WHERE o.crate_id=r.crate_template_id AND a.id=r.asset_id);

INSERT INTO public.crate_item_relations (crate_template_id, asset_id, drop_type, probability, token_count, is_prime_parcel, is_extra_crate)
SELECT o.crate_id, a.id, 'base', o.probability, 0, false, false
FROM crate_catalog_outcomes o JOIN public.crate_item_assets a ON a.asset_key=o.asset_key
ON CONFLICT (crate_template_id, asset_id, drop_type) DO UPDATE SET probability=EXCLUDED.probability,
  token_count=0, is_prime_parcel=false, is_extra_crate=false;

DO $$ BEGIN
  IF EXISTS (SELECT o.crate_id FROM (SELECT DISTINCT crate_id FROM crate_catalog_outcomes) o
    LEFT JOIN public.crate_item_relations r ON r.crate_template_id=o.crate_id AND r.drop_type='base'
    GROUP BY o.crate_id HAVING sum(r.probability) IS DISTINCT FROM 1::numeric
    OR count(r.id) <> (SELECT count(*) FROM crate_catalog_outcomes e WHERE e.crate_id=o.crate_id)) THEN
    RAISE EXCEPTION 'Crate import failed: invalid outcome count or probability total';
  END IF;
END $$;
COMMIT;
`;
}

async function uploadImages(catalog: CrateCatalog) {
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
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const catalogPath = option("--catalog");
  if (!catalogPath) throw new Error("Usage: tsx scripts/sync_crates.ts --catalog data/crates/<patch>.json [--verify-official <html>] [--write-sql <file>] [--upload-images]");
  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as CrateCatalog;
  validateCatalog(catalog);
  const officialPath = option("--verify-official");
  if (officialPath) verifyOfficialHtml(catalog, await fs.readFile(officialPath, "utf8"));
  const sqlPath = option("--write-sql");
  if (sqlPath) await fs.writeFile(sqlPath, buildCatalogSql(catalog, catalogPath));
  if (args.includes("--upload-images")) await uploadImages(catalog);
  console.table(catalog.crates.map(crate => ({ name: crate.name, outcomes: crate.items.length,
    total: Number(crate.items.reduce((sum, item) => sum + item.probability, 0).toFixed(6)) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
