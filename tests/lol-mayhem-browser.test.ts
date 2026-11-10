import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { LolMayhemCatalog } from "../lib/lol/augments/catalog";
import type { MayhemDatasetAdminData, PublicMayhemDataset } from "../lib/lol/mayhemDatasetView";
import type { ChampionDatasetAdminData, ChampionDatasetManifest, PublicChampionStats } from "../lib/lol/mayhemChampionDataset";

import { archivePage, type MayhemArchive } from "../lib/lol/mayhemArchive";
const archiveFixture: MayhemArchive = { schemaVersion:1, patch:"16.21", augments: Array.from({length:54},(_,i)=>({key:`official:${i+1}`,officialId:i+1,externalIds:[],name:i===52?"비활성 증강":i===53?"삭제된 증강":`사용 중 증강 ${i+1}`,nameEn:`Archive ${i+1}`,sourceName:null,rarity:"gold",status:i===52?"disabled":i===53?"removed":"active",removedPatch:i===53?"26.18":null,reason:i===53?"원본 26.18 삭제 기록":"공식 카탈로그",text:"증강 효과 ".repeat(10),sourceUrl:null})), combos:[{id:1,championId:63,augments:["official:1"],status:"active",types:["god"],sourceUrl:"https://arammayhem.com/combo/test/"},{id:2,championId:63,augments:["official:53"],status:"disabled",types:["trap"],sourceUrl:"https://arammayhem.com/combo/test/"},{id:3,championId:63,augments:["official:54"],status:"removed",types:[],sourceUrl:"https://arammayhem.com/combo/test/"}] };
async function openChampionPicker(page: Page) {
  const toggle = '[aria-label="챔피언 선택 열기"]';
  if (await page.$eval(toggle, node => node.getBoundingClientRect().height > 0 && node.getAttribute("aria-expanded") === "false")) await page.click(toggle);
}
async function chooseChampion(page: Page, id: string) {
  await openChampionPicker(page);
  await page.click(`button[data-champion-id="${id}"]`);
}

const catalog: LolMayhemCatalog = {
  clientPatch: "16.21", displayPatch: "26.21", releasedAt: "2026-10-20T18:00:00Z", notesUrl: "https://example.test/notes",
  removed: ["타오르는 이자", "Hide on bush"],
  augments: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1, name: index === 0 ? "아주 긴 이름을 가진 증강으로 줄바꿈을 확인합니다" : index === 11 ? "큰 표본 숫자와 나란히 표시되는 아주 긴 증강 이름 줄바꿈 검증 항목" : `증강 ${index + 1}`, nameEn: `Augment ${index + 1}`,
    rarity: (["prismatic", "gold", "silver"] as const)[index % 3], icon: index === 1 ? null : `assets/ux/kiwi/augments/icons/a${index}.png`,
    text: "공격 사거리가 원거리 100 / 근접 150 증가합니다. ".repeat(index === 0 ? 8 : 1), notice: index === 0 ? "스킬 이름은 챔피언마다 다릅니다" : null, isNew: index % 4 === 0,
  })),
};

const dataset: PublicMayhemDataset = { patch: "16.21", publishedAt: "2026-11-04T00:00:00Z", sourceStatsDate: "2026-11-02", sourcePatch: "26.21",
  rates: [{ augmentId: 1, pickRate: 12.34, rank: 1 }],
  combos: [{ id: 10, championId: 63, augmentIds: [1, 2], types: ["god"], sourceUrl: "https://arammayhem.com/combos/test" }] };
const championStats: PublicChampionStats = { schemaVersion: 1, source: "champion_api_v1", clientPatch: "16.20", cohort: "source_default", upstreamVersion: "16.20.1", sourceDataDate: "2026-11-02", fetchedAt: "2026-11-03T00:00:00Z", championId: 63, catalogHash: "a".repeat(64), attribution: "Data provider", publishedAt: "2026-11-04T00:00:00Z",
  rows: [
    { augmentPlatformId: 1, reportedPickRate: "0.0697", reportedSampleCount: null, rateSource: "tencent", rateRegion: "CN", countSource: null, countRegion: null, countMeaning: null, denominatorKind: "unverified_source_definition", denominatorCount: null, selectionEvidence: "reported_rate", offerEligibility: "unknown" },
    { augmentPlatformId: 12, reportedPickRate: "0.12", reportedSampleCount: 123456789012, rateSource: "iesdev", rateRegion: "WORLD", countSource: "iesdev", countRegion: "WORLD", countMeaning: "source_reported_games", denominatorKind: "unverified_source_definition", denominatorCount: null, selectionEvidence: "reported_count", offerEligibility: "unknown" },
    ...[2, 3].map(id => ({ augmentPlatformId: id, reportedPickRate: id === 2 ? "0" : null, reportedSampleCount: null, rateSource: "tencent", rateRegion: "CN", countSource: null, countRegion: null, countMeaning: null, denominatorKind: "unverified_source_definition" as const, denominatorCount: null, selectionEvidence: "reported_rate" as const, offerEligibility: "unknown" as const })),
  ] };
const championManifest: ChampionDatasetManifest = { schemaVersion: 1, source: "champion_api_v1", cohort: "source_default", clientPatch: "16.21", upstreamVersion: "16.21.1", sourceDataDate: "2026-11-03", catalogHash: "b".repeat(64), expectedChampionIds: [63], files: [], attribution: "Data provider", rightsBasis: "Documented permission basis", normalizerVersion: 1 };
const championAdminFixture = (): ChampionDatasetAdminData => ({ releases: [{ id: 2, status: "pending", client_patch: "16.21", source_data_date: "2026-11-03", upstream_version: "16.21.1", fetched_at: "2026-11-04T00:00:00Z", metadata: championManifest }], publications: [], sync: [], readiness: { apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true } });
const referenceAdminFixture = () => ({ enabled: true, publicEnabled: true, itemsEnabled: true, releases: ["champion_tiers", "item_ratings", "augment_rankings"].map((kind, index) => ({
  id: index + 1, kind, source: ["aramgg", "iesdev", "arammayhem"][index], client_patch: "16.21", champion_id: index === 2 ? 0 : 63,
  upstream_version: "1.2.3", source_data_date: "2026-11-03", raw_hash: "a".repeat(64), normalized_hash: "b".repeat(64),
  raw_path: "external/mayhem-reference/raw.json", normalized_path: "external/mayhem-reference/normalized.json", raw_bytes: 10, normalized_bytes: 20,
  attribution: "출처 표기", rights_basis: "사용 허가", status: "pending", fetched_at: "2026-11-04T00:00:00Z", reviewed_at: null,
})), publications: [] as Array<{ kind: string; client_patch: string; champion_id: number; release_id: number; previous_release_id: number | null; published_at: string }>, sync: [] });
const adminFixture = (): MayhemDatasetAdminData => ({ releases: [{ id: 1, verified_client_patch: "16.22", upstream_release_id: "source:" + "x".repeat(100), status: "pending", fetched_at: "2026-11-04T00:00:00Z",
  metadata: { unknown_count: 1, unknownExternalIds: ["augment!"], sourceStatsDate: "2026-11-02", sourceClientPatch: "16.21" } }], publications: [], mappings: [],
  augments: [{ platformId: 1, name: "아주 긴 공식 증강 이름으로 줄바꿈을 확인합니다", patch: "16.21" }, { platformId: 2, name: "검수 패치 전용 증강", patch: "16.22" }],
  sync: [{ job_key: "champion-stats", last_checked_at: "2026-11-04T00:00:00Z", last_success_at: null, last_error_code: "key_or_permission", consecutive_failures: 2, counts: {} }] });

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 증바람 공개 페이지 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const client = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { hydrateRoot } from 'react-dom/client'; import View from './components/lol/LolMayhemView';
        import Admin from './app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel';
        hydrateRoot(document.getElementById('root'), location.pathname === '/admin' ? <Admin /> : <View {...JSON.parse(document.getElementById('props').textContent)} />);
      ` },
    });
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const View = (await import("../components/lol/LolMayhemView")).default;
    const Admin = (await import("../app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel")).default;
    let archiveError = false; let archiveRace = false; let admin = adminFixture(); let referenceAdmin = referenceAdminFixture(); let statsMode: "success" | "empty" | "error" | "race" = "success"; let itemMode = "success"; let historyMode = "success"; let rankingMode = "success";
    server = createServer((req, res) => {
      if (req.url === "/archive-error") archiveError = true;
      if (req.url === "/archive-race") archiveRace = true;
      if (req.url === "/archive") { archiveError = false; archiveRace = false; }
      if (req.url?.startsWith("/api/lol/mayhem/tips/comments")) {
        res.setHeader("Content-Type", "application/json");
        const thread = [{ id: 1, parentId: null, body: "AP면 라이덴, AD면 도미닉 가세요", author: "고수", anonymous: false, deleted: false, mine: false, byTipAuthor: false, createdAt: "2026-11-10T00:00:00Z" },
          { id: 2, parentId: 1, body: "감사합니다!", author: null, anonymous: true, deleted: false, mine: false, byTipAuthor: true, createdAt: "2026-11-10T01:00:00Z" }];
        if (req.method === "POST") {
          let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
            const body = JSON.parse(raw);
            res.statusCode = 201;
            res.end(JSON.stringify({ comments: [...thread, { id: 3, parentId: body.parentId, body: body.body, author: body.anonymous ? null : "내닉네임", anonymous: body.anonymous, deleted: false, mine: true, byTipAuthor: false, createdAt: "2026-11-11T00:00:00Z" }] }));
          });
          return;
        }
        res.end(JSON.stringify({ comments: thread }));
        return;
      }
      if (req.url?.startsWith("/api/lol/mayhem/tips")) {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "DELETE") { res.end(JSON.stringify({ deleted: 99 })); return; }
        if (req.method === "POST" || req.method === "PATCH") {
          let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
            const body = JSON.parse(raw);
            if (req.url === "/api/lol/mayhem/tips/vote") { res.end(JSON.stringify({ up: body.value === 1 ? 6 : 5, down: body.value === -1 ? 1 : 0, myVote: body.value })); return; }
            res.statusCode = req.method === "POST" ? 201 : 200;
            res.end(JSON.stringify({ tip: { id: 99, createdAt: "2026-11-11T00:00:00Z", updatedAt: req.method === "PATCH" ? "2026-11-11T01:00:00Z" : null, author: body.anonymous ? null : "내닉네임", up: 0, down: 0, myVote: 0, mine: true, comments: 0, ...body } }));
          });
          return;
        }
        const common = new URL(req.url, "http://x").searchParams.get("champion") === "common";
        const base = { kind: "tip", anonymous: false, up: 5, down: 0, myVote: 0, mine: false, comments: 0, updatedAt: null, author: "칼바람장인" };
        const rows = [{ ...base, id: 1, championId: null, augmentIds: [1, 3], itemIds: [3020], summary: "누구나 쓰기 좋은 공용 조합", usage: "초반 실버에서 먼저 고르세요.\n두 번째 줄 설명", createdAt: "2026-11-10T00:00:00Z" },
          { ...base, anonymous: true, author: null, up: 2, id: 2, championId: 63, augmentIds: [1, 2, 3, 4], itemIds: [3020, 6655, 3089], summary: "브랜드 도트 피해 조합", usage: "", createdAt: "2026-11-09T00:00:00Z" }  , { ...base, kind: "question", id: 3, championId: null, augmentIds: [], itemIds: [3089, 6655], summary: "운명의 무기 뜨면 AP는 뭐 가요?", usage: "상대에 탱커가 없는데 도미닉이 좋을까요 오만이 좋을까요?", comments: 2, createdAt: "2026-11-08T00:00:00Z" }]
          .filter(row => !common || row.championId === null).filter(row => !new URL(req.url!, "http://x").searchParams.get("kind") || row.kind === new URL(req.url!, "http://x").searchParams.get("kind"));
        res.end(JSON.stringify({ patch: "16.21", offset: 0, signedIn: true, rows, total: rows.length }));
        return;
      }
      if (req.url?.startsWith("/api/lol/mayhem/archive?")) {
        res.setHeader("Content-Type","application/json");
        if (archiveError) { archiveError = false; res.statusCode=503;res.end(JSON.stringify({error:"failed"}));return; }
        const p = new URL(req.url,"http://fixture").searchParams;
        const payload = archivePage({ ...archiveFixture, patch: p.get("patch") ?? archiveFixture.patch },{kind:p.get("kind") as "augments"|"combos",status:p.get("status") as "active",query:p.get("q")??"",championId:p.has("championId")?Number(p.get("championId")):null,offset:Number(p.get("offset")??0)},"2026-11-05T00:00:00Z");
        const send = () => res.end(JSON.stringify(payload));
        if (archiveRace && p.get("status")==="disabled") { server.emit("delayed-archive-started");setTimeout(()=>{send();server.emit("delayed-archive-sent");},700); } else send();return;
      }
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client.outputFiles[0].text); return; }
      if (req.url === "/api/admin/lol/mayhem-datasets") {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST") {
          let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
            const payload = JSON.parse(body); const action = payload.action;
            if (action === "map" && payload.patch !== "16.21") { res.statusCode = 400; res.end(JSON.stringify({ error: "선택률 원본 패치가 아닙니다." })); return; }
            if (action === "map") admin.mappings.push({ external_id: payload.externalId, platform_id: payload.platformId, client_patch: payload.patch, status: "approved", evidence: { note: payload.evidence } });
            if (action === "sync") admin.releases[0].metadata = { ...admin.releases[0].metadata, unknown_count: 0, unknownExternalIds: [] };
            if (action === "approve") admin.releases[0].status = "approved";
            res.end(JSON.stringify({ ok: true }));
          });
        } else res.end(JSON.stringify(admin));
        return;
      }
      if (req.url?.startsWith("/api/admin/lol/mayhem-datasets?mapping=")) {
        res.setHeader("Content-Type", "application/json");
        const source = { externalId: "augment!", name: "아주 긴 공식 증강 이름으로 줄바꿈을 확인합니다", nameEn: "Source augment", rarity: "gold", conflict: false, uses: ["rates"] };
        const augments = [{ id: 1, name: source.name, nameEn: source.nameEn, rarity: "gold", text: "공식 효과와 원본 이름을 나란히 비교합니다. ".repeat(8), icon: null, isNew: false, notice: null }];
        res.end(JSON.stringify({ releaseId: 1, sources: admin.releases[0].metadata.unknown_count ? [source] : [], patches: [
          { patch: "16.22", purpose: "추천 조합", externalIds: [], augments },
          { patch: "16.21", purpose: "전체 선택률", externalIds: [source.externalId], augments },
        ], mappings: admin.mappings })); return;
      }
      if (req.url === "/api/admin/lol/mayhem-references") {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST") {
          let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
            const payload = JSON.parse(body), row = referenceAdmin.releases.find(row => row.id === payload.id)!;
            if (payload.action === "approve") row.status = "approved";
            if (payload.action === "publish") referenceAdmin.publications.push({ kind: row.kind, client_patch: row.client_patch, champion_id: row.champion_id, release_id: row.id, previous_release_id: null, published_at: "2026-11-05T00:00:00Z" });
            res.end(JSON.stringify({ ok: true }));
          });
        } else res.end(JSON.stringify(referenceAdmin));
        return;
      }
      if (req.url?.startsWith("/rankings")) rankingMode=req.url.slice(1);
      if (req.url?.startsWith("/api/lol/mayhem/patch-rankings")) {
        const patch=new URL(req.url,"http://fixture.test").searchParams.get("patch")??"26.21";
        if(rankingMode==="rankings-error"){rankingMode="success";res.statusCode=503;res.end("{}");return;}
        const payload={patches:["26.21","26.20","26.19"],ranking:{patch,date:"2026-10-20",estimated:patch!=="26.21",rows:[
          {id:"top",name:patch==="26.21"?"현재 증강":"과거 증강",rarity:"gold",pickRate:patch==="26.21"?40:10,rank:1},
          {id:"zero",name:"선택률 0 증강",rarity:"silver",pickRate:0,rank:2},
          {id:"missing",name:"미제공 증강",rarity:"prismatic",pickRate:null,rank:null},
        ]}};
        const send=()=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(payload));};
        if(rankingMode==="rankings-race"&&patch==="26.20"){server.emit("delayed-rankings-started");setTimeout(()=>{send();server.emit("delayed-rankings-sent");},700);}else send();return;
      }
      if (req.url?.startsWith("/history")) historyMode = req.url.slice(1);
      if (req.url?.startsWith("/api/lol/mayhem/champion-history/")) {
        const id = Number(req.url.split("/").at(-1)?.split("?")[0]);
        if (historyMode === "history-error") { historyMode = "success"; res.statusCode = 503; res.end("{}"); return; }
        const history = { patch: "16.21", patches: ["16.21","16.20","16.19","16.18"].map(patch => ({patch,available:true})), rows: [
          { augmentPlatformId: 1, status: "unobserved", missingSince: "16.19", consecutiveMissing: 3, lastObservedPatch: "16.18" },
          { augmentPlatformId: 2, status: "never_observed", missingSince: null, consecutiveMissing: 0, lastObservedPatch: null },
          { augmentPlatformId: 3, status: "insufficient", missingSince: null, consecutiveMissing: 0, lastObservedPatch: "16.18" },
          { augmentPlatformId: 4, status: "observed", missingSince: null, consecutiveMissing: 0, lastObservedPatch: "16.21" },
        ] };
        if (historyMode === "history-gaps") {
          history.patches[2].available = false;
          history.rows[0] = { ...history.rows[0], status: "insufficient", missingSince: null, consecutiveMissing: 0 };
          history.rows[1] = { ...history.rows[1], status: "insufficient" };
        }
        if (id === 64) history.rows = history.rows.slice(1);
        const send = () => { res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({history})); };
        if (historyMode === "history-race" && id === 63) { server.emit("delayed-history-started"); setTimeout(() => { send(); server.emit("delayed-history-sent"); },700); } else send();
        return;
      }
      if (req.url?.startsWith("/items")) itemMode = req.url.slice(1);
      if (req.url?.startsWith("/api/lol/mayhem/champion-items/")) {
        const id = Number(req.url.split("/").at(-1));
        if (itemMode === "items-error") { itemMode = "success"; res.statusCode = 503; res.end("{}"); return; }
        const items = [
          { id: 3089, name: "라바돈의 죽음모자", image: "3089.png", tier: 1, isBoots: false, components: [1058,1058].map(id => ({ id, name: "쓸데없이 큰 지팡이", image: "1058.png" })) },
          { id: 3115, name: "내셔의 이빨", image: "3115.png", tier: 2, isBoots: false, components: [] },
          { id: 3006, name: "광전사의 군화", image: "3006.png", tier: 1, isBoots: true, components: [] },
        ];
        const payload = { dataset: itemMode === "items-empty" ? null : { championId: id, patch: "16.22", version: "16.22.1", date: "2026-11-04", items: id === 64 ? items.slice(1) : items } };
        const send = () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(payload)); };
        if (itemMode === "items-race" && id === 63) { server.emit("delayed-items-started"); setTimeout(() => { send(); server.emit("delayed-items-sent"); }, 700); } else send();
        return;
      }
      if (req.url === "/admin") { admin = adminFixture(); referenceAdmin = referenceAdminFixture(); }
      if (req.url === "/stats-empty") statsMode = "empty";
      else if (req.url === "/stats-error") statsMode = "error";
      else if (req.url === "/stats-race") statsMode = "race";
      else if (req.url === "/stats") statsMode = "success";
      if (req.url?.startsWith("/api/admin/lol/mayhem-champion-datasets")) {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST") { res.end(JSON.stringify({ ok: true })); return; }
        res.end(JSON.stringify({ ...championAdminFixture(), databaseAvailable: true })); return;
      }
      if (req.url?.startsWith("/api/lol/mayhem/champion-stats/")) {
        if (statsMode === "error") { res.statusCode = 503; res.end(JSON.stringify({ error: "unavailable" })); return; }
        const id = Number(req.url.split("/").at(-1)?.split("?")[0]);
        if (statsMode === "empty") { res.end(JSON.stringify({ dataset: null })); return; }
        const payload = { ...championStats, championId: id, rows: championStats.rows.map(row => statsMode === "race" && id === 64 ? { ...row, reportedPickRate: "0.8888" } : row) };
        const send = () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ dataset: payload })); };
        if (id === 63 && statsMode === "race") {
          server.emit("delayed-stats-started");
          setTimeout(() => { send(); server.emit("delayed-stats-sent"); }, 700);
        } else if (id === 63) setTimeout(send, 300); else send();
        return;
      }
      const champs = [{ id: 63, imageId: "Brand", name: "브랜드", title: "", tags: [] }, { id: 64, imageId: "Lux", name: "럭스", title: "", tags: [] }];
      const isStats = req.url?.startsWith("/stats") || req.url?.startsWith("/items") || req.url?.startsWith("/history") || req.url?.startsWith("/rankings");
      const tipItems = [{ id: 3020, name: "마법사의 신발", image: "3020.png", boots: true }, { id: 6655, name: "루덴의 동반자", image: "6655.png", boots: false }, { id: 3089, name: "라바돈의 죽음모자", image: "3089.png", boots: false }];
      const props = req.url === "/tips" ? { catalog, champions: champs, championVersion: "16.21.1", tipItems } : req.url?.startsWith("/archive") ? {catalog,dataset:{...dataset,archiveAvailable:true},champions:champs,championStatsEnabled:false} : req.url === "/rankings-no-catalog" ? {catalog:null,error:true,patchRankingsEnabled:true} : req.url === "/error" ? { catalog: null, error: true } : req.url === "/empty" ? { catalog: null } : req.url === "/fallback"
        ? { catalog, dataset: { ...dataset, patch: "16.20", archiveAvailable: true }, champions: champs, championStatsEnabled: true, championVersion: "16.21.1", itemsEnabled: true, championTiers: { patch: "16.20", dataVersion: "16.20.3", date: "2026-10-16", tiers: { "63": 3, "64": 1 } } }
        : req.url === "/dataset"
        ? { catalog, dataset, champions: champs, championStatsEnabled: true, championVersion: "16.21.1" } : isStats ? { catalog, champions: champs, championStatsEnabled: req.url !== "/items-only", championVersion: "16.21.1", itemsEnabled: true, championTiers: req.url?.startsWith("/rankings") ? {patch:"16.21",dataVersion:"16.21.5",date:"2026-10-30",tiers:{"63":3,"64":1}} : null, patchRankingsEnabled: req.url?.startsWith("/rankings") } : { catalog };
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<link rel="stylesheet" href="/style.css"></head><body class="bg-zinc-950"><div id="root">${req.url === "/admin" ? renderToString(createElement(Admin)) : renderToString(createElement(View, props))}</div>`
        + `<script type="application/json" id="props">${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script src="/client.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 주소 확인 실패");
    base = `http://127.0.0.1:${address.port}`; browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/lol-mayhem-review", { recursive: true });
  }, 90_000);
  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 공용·챔피언 조합을 등급별 증강과 아이템으로 제보한다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    // 외부 이미지 요청은 막고 제보 저장 본문만 기록한다.
    const sent: string[] = []; await page.setRequestInterception(true);
    page.on("request", request => { if (["POST", "PATCH"].includes(request.method())) sent.push(request.postData() ?? ""); if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
    const click = (selector: string, text: string) => page.$$eval(selector, (nodes, label) => (nodes as HTMLElement[]).find(node => node.textContent?.trim() === label)!.click(), text);
    await page.goto(`${base}/tips`, { waitUntil: "networkidle0" });
    await click('[aria-label="증바람 보기"] button', "유저 조합 제보");
    await page.waitForSelector('[aria-label="유저 조합 목록"] > li');
    expect(await page.$eval('[aria-label="유저 조합 목록"]', node => node.textContent)).toContain("공용 조합");
    await click("button", "조합 제보하기");
    await page.waitForSelector('form[aria-label="조합 제보"]');
    // 등급 탭마다 그 등급 증강만 보인다.
    await click('[aria-label="증강 등급"] button', "골드");
    expect(await page.$$eval('[aria-label="증강 목록"] button', nodes => nodes.map(node => node.textContent))).toEqual(["증강 2", "증강 5", "증강 8", "증강 11"]);
    await click('[aria-label="증강 목록"] button', "증강 2");
    await click('[aria-label="증강 등급"] button', "프리즘");
    await click('[aria-label="증강 목록"] button', "증강 4");
    await click('[aria-label="아이템 목록"] button', "루덴의 동반자");
    await click('[aria-label="아이템 목록"] button', "마법사의 신발");
    expect(await page.$$eval('[aria-label="고른 증강"] li', nodes => nodes.length)).toBe(2);
    await page.type('form[aria-label="조합 제보"] input:not([type])', "공용으로 쓰기 좋은 조합");
    await page.type("form textarea", "골드 먼저 고르고 프리즘에서 마무리");
    await page.click('form input[role="switch"]');
    expect(await page.$eval("form", node => node.textContent)).toContain('작성자가 "익명"으로 보입니다');
    await page.screenshot({ path: `tmp/lol-mayhem-review/tips-form-${width}x${height}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await click("form button", "조합 제보하기");
    await page.waitForFunction(() => document.querySelector('[aria-label="유저 조합 목록"]')?.textContent?.includes("공용으로 쓰기 좋은 조합"));
    expect(JSON.parse(sent[0])).toEqual({ championId: null, augmentIds: [2, 4], itemIds: [6655, 3020], summary: "공용으로 쓰기 좋은 조합", usage: "골드 먼저 고르고 프리즘에서 마무리", anonymous: true, kind: "tip" });
    const card = (summary: string) => page.$$eval('[aria-label="유저 조합 목록"] > li', (nodes, text) => nodes.find(node => node.textContent?.includes(text))?.textContent ?? "", summary);
    expect(await card("공용으로 쓰기 좋은 조합")).toContain("익명(내 글)");
    expect(await card("누구나 쓰기 좋은")).toContain("칼바람장인");
    // 남의 제보에는 투표하고, 내 제보에는 투표 버튼이 막힌다.
    await page.$$eval('[aria-label="유저 조합 목록"] > li', nodes => (nodes.find(node => node.textContent?.includes("누구나 쓰기 좋은"))!.querySelector('button[aria-label^="추천"]') as HTMLButtonElement).click());
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="유저 조합 목록"] > li')].find(node => node.textContent?.includes("누구나 쓰기 좋은"))?.querySelector('button[aria-label="추천 6"][aria-pressed="true"]'));
    expect(await page.$$eval('[aria-label="유저 조합 목록"] > li', nodes => (nodes.find(node => node.textContent?.includes("공용으로 쓰기 좋은"))!.querySelector('button[aria-label^="추천"]') as HTMLButtonElement).disabled)).toBe(true);
    // 내 제보를 고치고 지운다.
    await click('[aria-label="유저 조합 목록"] button', "수정");
    await page.waitForSelector('form[aria-label="조합 제보 수정"]');
    await page.$eval('form[aria-label="조합 제보 수정"] input:not([type])', node => { (node as HTMLInputElement).select(); });
    await page.type('form[aria-label="조합 제보 수정"] input:not([type])', "고친 한줄평");
    await click('form[aria-label="조합 제보 수정"] button', "수정 저장");
    await page.waitForFunction(() => document.querySelector('[aria-label="유저 조합 목록"]')?.textContent?.includes("고친 한줄평"));
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ id: 99, summary: "고친 한줄평", anonymous: true });
    expect(await card("고친 한줄평")).toContain("수정됨");
    await page.screenshot({ path: `tmp/lol-mayhem-review/tips-list-${width}x${height}.png`, fullPage: true });
    await click('[aria-label="유저 조합 목록"] button', "지우기");
    await click('[aria-label="유저 조합 목록"] button', "삭제");
    await page.waitForFunction(() => !document.querySelector('[aria-label="유저 조합 목록"]')?.textContent?.includes("고친 한줄평"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); await page.close();
  });

  it.each([[375, 667], [1440, 900]])("%ix%i에서 질문을 올리고 답변·답글을 단다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const sent: string[] = []; await page.setRequestInterception(true);
    page.on("request", request => { if (request.method() === "POST") sent.push(request.postData() ?? ""); if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
    const click = (selector: string, text: string) => page.$$eval(selector, (nodes, label) => (nodes as HTMLElement[]).find(node => node.textContent?.trim() === label)!.click(), text);
    await page.goto(`${base}/tips`, { waitUntil: "networkidle0" });
    await click('[aria-label="증바람 보기"] button', "유저 조합 제보");
    await page.waitForSelector('[aria-label="유저 조합 목록"] > li');
    await click('[aria-label="글 종류 필터"] button', "질문");
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="유저 조합 목록"] > li').length === 1);
    // 답변을 열면 답글이 들여쓰기로 보이고 글쓴이 표시가 붙는다.
    await click('[aria-label="유저 조합 목록"] button', "답변 2");
    await page.waitForSelector('[aria-label="답변 목록"] [aria-label="답글"] li');
    expect(await page.$eval('[aria-label="답변 목록"]', node => node.textContent)).toContain("글쓴이");
    await click('[aria-label="답변 목록"] button', "답글");
    await page.type('[aria-label="답변 목록"] textarea[aria-label="답글 달기"]', "저도 궁금해요");
    await page.$$eval('[aria-label="답글"] form button[type="submit"]', nodes => (nodes[0] as HTMLButtonElement).click());
    await page.waitForFunction(() => document.querySelector('[aria-label="답변 목록"]')?.textContent?.includes("저도 궁금해요"));
    expect(JSON.parse(sent.at(-1)!)).toEqual({ tipId: 3, parentId: 1, body: "저도 궁금해요", anonymous: false });
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="유저 조합 목록"] button[aria-expanded]')].some(node => node.textContent === "답변 3"));
    // 질문은 증강 없이 올린다.
    await click("button", "질문하기");
    await page.waitForSelector('form[aria-label="질문"]');
    await page.type('form[aria-label="질문"] input:not([type])', "도미닉 오만 뭐가 좋아요?");
    await click('form[aria-label="질문"] button', "질문 올리기");
    await page.waitForFunction(() => !document.querySelector('form[aria-label="질문"]'));
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ kind: "question", augmentIds: [], summary: "도미닉 오만 뭐가 좋아요?" });
    await page.screenshot({ path: `tmp/lol-mayhem-review/tips-question-${width}x${height}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); await page.close();
  });

  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 검색·등급·신규 필터와 빈·오류 상태가 넘치지 않는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base) && (!request.url().includes("/api/lol/") || (request.url().includes("/api/lol/mayhem/champion-stats/") || (request.url().includes("/api/lol/mayhem/champion-items/") || request.url().includes("/api/lol/mayhem/champion-history/"))))) void request.continue(); else void request.abort(); });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const count = () => page.$$eval('ul[aria-label="증강 목록"] > li', items => items.length);
    const press = (label: string) => page.$$eval('[role="group"] button', (buttons, text) => (buttons as HTMLElement[]).find(button => button.textContent === text)!.click(), label);

    await page.goto(base, { waitUntil: "networkidle0" });
    expect(await count()).toBe(12); expect(await noOverflow()).toBe(true);
    expect(await page.$eval('ul[aria-label="증강 목록"] img', image => image.getAttribute("src"))).toBe("/api/lol/augment-icons/16.21/assets/ux/kiwi/augments/icons/a0.png");
    await page.screenshot({ path: `tmp/lol-mayhem-review/${width}x${height}.png` });
    await press("프리즘");
    expect(await page.$$eval('ul[aria-label="증강 목록"] > li', items => items.every(item => item.getAttribute("data-rarity") === "prismatic"))).toBe(true);
    await press("신규만"); expect(await count()).toBe(1);
    await press("전체"); await press("신규만");
    await page.type('input[type="search"]', "Augment 2"); expect(await count()).toBe(1);
    await page.type('input[type="search"]', "없는이름");
    expect(await page.$eval("main", main => main.textContent)).toContain("조건에 맞는 증강이 없습니다.");
    expect(await noOverflow()).toBe(true);
    expect(await page.$$eval("button, input", items => items.every(item => item.getBoundingClientRect().height >= 44))).toBe(true);

    await page.goto(`${base}/error`, { waitUntil: "networkidle0" });
    expect(await page.$eval('[role="alert"]', alert => alert.textContent)).toContain("불러오지 못했습니다");
    await page.goto(`${base}/empty`, { waitUntil: "networkidle0" });
    expect(await page.$eval("main", main => main.textContent)).toContain("아직 게시된 증강 정보가 없습니다.");
    expect(await noOverflow()).toBe(true); expect(errors).toEqual([]);
    await page.close();
  });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 조합과 전체 선택률을 구분하고 미매핑 승인을 막는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base) && (!request.url().includes("/api/lol/") || (request.url().includes("/api/lol/mayhem/champion-stats/") || (request.url().includes("/api/lol/mayhem/champion-items/") || request.url().includes("/api/lol/mayhem/champion-history/"))))) void request.continue(); else void request.abort(); });
    await page.goto(`${base}/dataset`, { waitUntil: "networkidle0" });
    await page.click("main > details > summary");
    await page.select('section[aria-label="해외 증바람 자료"] select', "63");
    expect(await page.$eval('[aria-label="해외 증바람 자료"]', node => node.textContent)).toContain(" + 증강 2");
    expect(await page.$eval('[aria-label="해외 증바람 자료"]', node => node.textContent)).toContain("등장 확률을 뜻하지 않습니다");
    await page.click('[aria-label="해외 증바람 자료"] details > summary');
    expect(await page.$eval('[aria-label="해외 증바람 자료"] details', node => node.textContent)).toContain("12.34%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/dataset-${width}x${height}.png`, fullPage: true });
    await page.goto(`${base}/admin`, { waitUntil: "networkidle0" });
    expect(await page.$eval("h1", node => node.textContent)).toBe("증바람 데이터 관리");
    await page.waitForSelector('article[aria-label="아이템·신발"]');
    expect(await page.$('[role="tablist"]')).toBeNull();
    await page.screenshot({ path: `tmp/lol-mayhem-review/admin-simple-${width}x${height}.png`, fullPage: true });
    await page.click('article[aria-label="아이템·신발"] button');
    await page.waitForSelector('[aria-label="아이템·신발 적용 확인"]');
    expect(await page.$eval('[aria-label="아이템·신발 적용 확인"]', n => n.textContent)).toContain("사용자 화면을 갱신");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/admin-confirm-${width}x${height}.png`, fullPage: true });
    await page.click('[aria-label="아이템·신발 적용 확인"] button');
    await page.waitForFunction(() => document.querySelector('article[aria-label="아이템·신발"]')?.textContent?.includes("적용됨"));
    expect(await page.$eval('[aria-label="수집 자료와 화면 적용"]', n => n.textContent)).toContain("자료 1개를 적용했습니다.");
    expect(await page.$eval('article[aria-label="증강 추천 조합"] button', n => n.textContent)).toBe("이름 연결하기");
    await page.click('article[aria-label="증강 추천 조합"] button:first-of-type');
    await page.waitForSelector('[aria-label="연결할 자료"]');
    expect(await page.$('[role="tablist"]')).toBeNull();
    expect(await page.$('[aria-label="외부 증강 ID"]')).toBeNull();
    await page.select('[aria-label="연결할 자료"]', "16.21");
    await page.waitForSelector('[aria-label="연결할 게임 증강"]');
    expect(await page.$eval('[aria-label="증강 이름 비교"]', n => n.textContent)).toContain("공식 효과와 원본 이름");
    const saveMapping = () => page.$eval('[aria-label="증강 이름 비교"] button', n => (n as HTMLButtonElement).disabled);
    expect(await saveMapping()).toBe(true);
    await page.click('[aria-label="증강 이름 비교"] input[type="checkbox"]');
    expect(await saveMapping()).toBe(false);
    await page.screenshot({ path: `tmp/lol-mayhem-review/admin-mapping-${width}x${height}.png`, fullPage: true });
    await page.click('[aria-label="증강 이름 비교"] button');
    await page.waitForFunction(() => document.querySelector('[aria-label="증강 이름 연결"]')?.textContent?.includes("1개 이름 연결을 저장했습니다"));
    await page.$$eval('[aria-label="증강 이름 연결"] button', buttons => (buttons.find(n => n.textContent === "연결 결과 반영") as HTMLButtonElement).click());
    await page.waitForFunction(() => [...document.querySelectorAll('article[aria-label="증강 추천 조합"] button')].some(n => n.textContent === "적용 내용 확인" && !(n as HTMLButtonElement).disabled));
    expect(await page.$$eval("button, select, textarea", nodes => (nodes as HTMLElement[]).filter(node => node.offsetParent !== null).every(node => node.getBoundingClientRect().height >= 44))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/admin-${width}x${height}.png`, fullPage: true });
    await page.close();
  });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 챔피언 통계 상태·표시·빠른 선택 전환을 확인한다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base) && (!request.url().includes("/api/lol/") || (request.url().includes("/api/lol/mayhem/champion-stats/") || (request.url().includes("/api/lol/mayhem/champion-items/") || request.url().includes("/api/lol/mayhem/champion-history/"))))) void request.continue(); else void request.abort(); });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await page.goto(`${base}/stats`, { waitUntil: "networkidle0" });
    const selected = 'button[data-champion-id="64"]';
    expect(await page.$('ul[aria-label="증강 목록"]')).toBeNull();
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("6.97%"));
    await openChampionPicker(page);
    expect(await page.$eval(selected, node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.focus(selected); await page.keyboard.press("Enter");
    await chooseChampion(page, "63");
    await chooseChampion(page, "64");
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("6.97%"));
    const text = await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent ?? "");
    expect(text).not.toContain("CN"); expect(text).not.toContain("WORLD"); expect(text).not.toContain("Data provider"); expect(text).toContain("이전 패치 통계");
    const rows = await page.$$eval('[aria-label="챔피언별 선택 통계"] ul > li', items => items.map(item => item.textContent ?? ""));
    expect(rows[0]).toContain("123,456,789,012"); expect(rows[1]).not.toContain("표본 ");
    expect(rows[2]).toContain("0.00%"); expect(rows[3]).toContain("미제공");
    expect(rows[0]).toContain("공격 사거리");
    expect(await page.$eval('[aria-label="챔피언별 선택 통계"] ul', node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(1);
    await page.click('[aria-label="통계 증강 등급"] button[data-rarity="gold"]');
    expect(await page.$$eval('[aria-label="챔피언별 선택 통계"] ul > li', items => items.length)).toBe(1);
    await page.click('[aria-label="통계 증강 등급"] button:first-child');
    await page.type('input[aria-label="통계 증강 검색"]', "없는증강");
    expect(await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent)).toContain("조건에 맞는 증강이 없습니다");
    await page.click('[aria-label="통계 필터 초기화"]');
    expect(await page.$$eval('[aria-label="챔피언별 선택 통계"] ul > li', items => items.length)).toBe(4);
    await openChampionPicker(page);
    await page.type('input[aria-label="통계 챔피언 검색"]', "ㄹㅅ");
    expect(await page.$eval(selected, node => node.getAttribute("aria-pressed"))).toBe("true");
    expect(await page.$$eval('[aria-label="통계 챔피언 목록"] button', items => items.length)).toBe(1);
    expect(await page.$eval(`${selected} img`, node => node.getAttribute("src"))).toContain("/16.21.1/img/champion/Lux.png");
    await page.type('input[aria-label="통계 챔피언 검색"]', "없는챔피언");
    expect(await page.$eval('[aria-label="챔피언별 선택 통계"] h3', node => node.textContent)).toContain("럭스");
    expect(await page.$eval('[aria-label="통계 챔피언 목록"]', node => node.textContent)).toContain("일치하는 챔피언이 없습니다");
    expect(await noOverflow()).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/champion-stats-${width}x${height}.png`, fullPage: true });
    await page.click('[aria-label="증바람 보기"] button:nth-child(2)');
    expect(await page.$$eval('ul[aria-label="증강 목록"] > li', items => items.length)).toBe(12);
    await page.click('[aria-label="증바람 보기"] button:first-child');
    expect(await page.$('[aria-label="챔피언 선택 열기"]')).not.toBeNull();
    await page.goto(`${base}/stats-empty`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("아직 없습니다"));
    await page.goto(`${base}/stats-error`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="챔피언별 선택 통계"] [role="alert"]');
    expect(await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent)).toContain("다시 시도");
    expect(errors).toEqual([]); await page.close();
  });

  it("이전 챔피언의 응답이 늦게 도착해도 현재 챔피언의 통계를 유지한다", async () => {
    const page = await browser.newPage();
    const started = new Promise<void>(resolve => server.once("delayed-stats-started", resolve));
    const sent = new Promise<void>(resolve => server.once("delayed-stats-sent", resolve));
    await page.goto(`${base}/stats-race`, { waitUntil: "domcontentloaded" });
    await started;
    await chooseChampion(page, "64");
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("88.88%"));
    await sent;
    await page.waitForNetworkIdle({ idleTime: 500 });
    const text = await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent);
    expect(text).toContain("럭스"); expect(text).toContain("88.88%"); expect(text).not.toContain("6.97%");
    await page.close();
  });
  it.each([[375,667],[390,844],[430,932],[1440,900]])("%ix%i에서 증바람 아이템 등급·재료·독립 패치·재시도·빈 상태를 확인한다", async (width,height) => {
    const page = await browser.newPage(); await page.setViewport({width,height});
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => request.url().startsWith(base) ? void request.continue() : void request.abort());
    await page.goto(`${base}/items`, {waitUntil:"networkidle0"});
    await page.click('[aria-label="챔피언 상세 보기"] button:nth-child(2)');
    await page.waitForSelector('[aria-label="증바람 아이템 목록"] > li');
    const text = await page.$eval('[aria-label="증바람 아이템 평가"]', node => node.textContent);
    expect(text).toContain("아이템 패치 26.22"); expect(text).toContain("평가 기준일 2026-11-04");
    expect(text).not.toContain("등급 산정식"); expect(text).not.toContain("실제 구매 순서"); expect(text).not.toContain("26.21");
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li:first-child ul li', nodes => nodes.length)).toBe(2);
    expect(await page.$eval('[aria-label="증바람 아이템 목록"] img', node => node.getAttribute("src"))).toContain("/16.22.1/img/item/");
    expect(text).not.toContain("광전사의 군화");
    expect(await page.$eval('[aria-label="증바람 아이템 목록"]', node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(1);
    expect(await page.$eval('input[aria-label="아이템 검색"]', node => node.getAttribute("placeholder"))).toBeNull();
    await page.click('[aria-label="아이템 분류"] button[data-category="boots"]');
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li', nodes => nodes.length)).toBe(1);
    expect(await page.$eval('[aria-label="증바람 아이템 목록"]', node => node.textContent)).toContain("광전사의 군화");
    await page.click('[aria-label="아이템 평가 등급"] button[data-tier="2"]');
    await page.waitForSelector('[aria-label="아이템 필터 초기화"]');
    await page.click('[aria-label="아이템 필터 초기화"]');
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li', nodes => nodes.length)).toBe(1);
    await page.type('input[aria-label="아이템 검색"]', "군화");
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li', nodes => nodes.length)).toBe(1);
    await page.screenshot({path:`tmp/lol-mayhem-review/boots-${width}x${height}.png`,fullPage:true});
    await page.focus('[aria-label="아이템 분류"] button[data-category="equipment"]');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-category="equipment"]')?.getAttribute("aria-pressed") === "true" && (document.querySelector('input[aria-label="아이템 검색"]') as HTMLInputElement)?.value === "");
    await page.click('[aria-label="아이템 평가 등급"] button[data-tier="2"]');
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li', nodes => nodes.length)).toBe(1);
    await page.type('input[aria-label="아이템 검색"]', "없는아이템");
    await page.waitForSelector('[aria-label="아이템 필터 초기화"]'); await page.click('[aria-label="아이템 필터 초기화"]');
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li', nodes => nodes.length)).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.$$eval('[aria-label="증바람 아이템 평가"] button,input[aria-label="아이템 검색"]', nodes => nodes.every(node => node.getBoundingClientRect().height >= 44))).toBe(true);
    await page.screenshot({path:`tmp/lol-mayhem-review/items-${width}x${height}.png`,fullPage:true});
    await chooseChampion(page,"64");
    await page.waitForSelector('[aria-label="증바람 아이템 평가"][data-champion-id="64"]');
    expect(await page.$$eval('[aria-label="증바람 아이템 목록"] > li', nodes => nodes.length)).toBe(1);
    await page.goto(`${base}/items-error`, {waitUntil:"networkidle0"}); await page.click('[aria-label="챔피언 상세 보기"] button:nth-child(2)');
    await page.waitForSelector('[aria-label="챔피언별 선택 통계"] [role="alert"]');
    await page.click('[aria-label="챔피언별 선택 통계"] [role="alert"] button');
    await page.waitForSelector('[aria-label="증바람 아이템 목록"] > li');
    await page.goto(`${base}/items-empty`, {waitUntil:"networkidle0"}); await page.click('[aria-label="챔피언 상세 보기"] button:nth-child(2)');
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("아이템 평가가 아직 없습니다"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); await page.close();
  });
  it("늦은 아이템 응답이 다른 챔피언의 평가를 덮어쓰지 않는다", async () => {
    const page = await browser.newPage();
    const started = new Promise<void>(resolve => server.once("delayed-items-started", resolve));
    const sent = new Promise<void>(resolve => server.once("delayed-items-sent", resolve));
    await page.goto(`${base}/items-race`, {waitUntil:"networkidle0"});
    await page.click('[aria-label="챔피언 상세 보기"] button:nth-child(2)'); await started;
    await chooseChampion(page,"64"); await page.waitForSelector('[aria-label="증바람 아이템 평가"][data-champion-id="64"]');
    await sent; await page.waitForNetworkIdle({idleTime:500});
    expect(await page.$eval('[aria-label="증바람 아이템 평가"]', node => node.getAttribute("data-champion-id"))).toBe("64");
    expect(await page.$eval('[aria-label="증바람 아이템 평가"]', node => node.textContent)).not.toContain("라바돈");
    await page.close();
  });

  it("증강 통계를 끈 상태에서도 증바람 아이템을 독립적으로 보여준다", async () => {
    const page = await browser.newPage();
    const requests: string[] = []; page.on("request", request => requests.push(request.url()));
    await page.goto(`${base}/items-only`, {waitUntil:"networkidle0"});
    await page.waitForSelector('[aria-label="증바람 아이템 목록"] > li');
    expect(requests.some(url => url.includes("/champion-stats/"))).toBe(false);
    expect(await page.$('[aria-label="챔피언 상세 보기"]')).toBeNull();
    expect(await page.$eval('[aria-label="증바람 아이템 평가"]', node => node.textContent)).toContain("26.22");
    await page.close();
  });

  it.each([[375,667],[390,844],[430,932],[1440,900]])("%ix%i에서 관측 이력의 상태·검색·자료 부족·재시도를 확인한다", async (width,height) => {
    const page = await browser.newPage(); await page.setViewport({width,height});
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const requests: string[] = []; page.on("request", request => requests.push(request.url()));
    await page.setRequestInterception(true); page.on("request", request => request.url().startsWith(base) ? void request.continue() : void request.abort());
    await page.goto(`${base}/history`, {waitUntil:"networkidle0"});
    expect(requests.some(url => url.includes("/champion-history/"))).toBe(false);
    await page.click('[aria-label="챔피언 상세 보기"] button:last-child');
    await page.waitForSelector('[aria-label="증강 관측 이력"] > li');
    const text = await page.$eval('[aria-label="선택 관측 이력"]',node=>node.textContent);
    expect(text).toContain("26.19부터 3패치 연속 미관측"); expect(text).toContain("관측 이력 없음"); expect(text).toContain("자료 부족"); expect(text).toContain("선택 관측");
    expect(text).toContain("최근 최대 4패치"); expect(text).toContain("미관측은 등장 불가를 뜻하지 않습니다");
    await page.select('select[aria-label="관측 상태"]', "never_observed");
    expect(await page.$$eval('[aria-label="증강 관측 이력"] > li', nodes=>nodes.length)).toBe(1);
    await page.type('input[aria-label="관측 증강 검색"]', "없는증강");
    await page.waitForFunction(()=>document.querySelector('[aria-label="선택 관측 이력"]')?.textContent?.includes("조건에 맞는 관측 이력이 없습니다"));
    await page.focus('[aria-label="선택 관측 이력"] [role="status"] button'); await page.keyboard.press("Enter");
    await page.waitForSelector('[aria-label="증강 관측 이력"] > li');
    expect(await page.$$eval('[aria-label="증강 관측 이력"] > li', nodes=>nodes.length)).toBe(4);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.$$eval('[aria-label="선택 관측 이력"] input,[aria-label="선택 관측 이력"] select',nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44))).toBe(true);
    await page.screenshot({path:`tmp/lol-mayhem-review/history-${width}x${height}.png`,fullPage:true});
    await chooseChampion(page,"64"); await page.waitForSelector('[aria-label="선택 관측 이력"][data-champion-id="64"]');
    expect(await page.$$eval('[aria-label="증강 관측 이력"] > li', nodes=>nodes.length)).toBe(3);
    await page.goto(`${base}/history-error`,{waitUntil:"networkidle0"}); await page.click('[aria-label="챔피언 상세 보기"] button:last-child');
    await page.waitForSelector('[aria-label="챔피언별 선택 통계"] [role="alert"]');
    await page.click('[aria-label="챔피언별 선택 통계"] [role="alert"] button'); await page.waitForSelector('[aria-label="증강 관측 이력"] > li');
    await page.goto(`${base}/history-gaps`,{waitUntil:"networkidle0"}); await page.click('[aria-label="챔피언 상세 보기"] button:last-child');
    await page.waitForSelector('[aria-label="증강 관측 이력"] > li');
    expect(await page.$eval('[aria-label="패치별 자료 상태"]',node=>node.textContent)).toContain("자료 부족");
    expect(await page.$eval('[aria-label="증강 관측 이력"]',node=>node.textContent)).not.toContain("3패치 연속 미관측");
    expect(errors).toEqual([]); await page.close();
  });
  it("이전 챔피언의 느린 이력 응답이 현재 이력을 덮어쓰지 않는다", async () => {
    const page=await browser.newPage();
    const started=new Promise<void>(resolve=>server.once("delayed-history-started",resolve));
    const sent=new Promise<void>(resolve=>server.once("delayed-history-sent",resolve));
    await page.goto(`${base}/history-race`,{waitUntil:"networkidle0"}); await page.click('[aria-label="챔피언 상세 보기"] button:last-child'); await started;
    await chooseChampion(page,"64"); await page.waitForSelector('[aria-label="선택 관측 이력"][data-champion-id="64"]');
    await sent; await page.waitForNetworkIdle({idleTime:500});
    expect(await page.$$eval('[aria-label="증강 관측 이력"] > li',nodes=>nodes.length)).toBe(3);
    expect(await page.$eval('[aria-label="선택 관측 이력"]',node=>node.textContent)).not.toContain("3패치 연속 미관측");
    await page.close();
  });

  it.each([[375,667],[390,844],[430,932],[1440,900]])("%ix%i에서 티어순 챔피언과 과거 패치별 전체 증강 순위를 확인한다",async(width,height)=>{
    const page=await browser.newPage();await page.setViewport({width,height});const errors:string[]=[];page.on("pageerror",e=>errors.push(String(e)));
    await page.setRequestInterception(true);page.on("request",r=>r.url().startsWith(base)?void r.continue():void r.abort());
    await page.goto(`${base}/rankings`,{waitUntil:"networkidle0"});await openChampionPicker(page);
    expect(await page.$$eval('[aria-label="통계 챔피언 목록"] button',nodes=>nodes.map(n=>n.getAttribute("data-champion-id")))).toEqual(["64","63"]);
    expect(await page.$eval('button[data-champion-id="64"]',n=>n.textContent)).toContain("1티어");
    await page.click('[aria-label="증바람 보기"] button:nth-child(2)');await page.waitForSelector('[aria-label="패치 증강 순위 목록"] > li');
    expect(await page.$eval('[aria-label="패치별 증강 순위"]',n=>n.textContent)).toContain("모든 챔피언을 합친 통계");
    await page.select('select[aria-label="증강 순위 패치"]',"26.20");
    await page.waitForFunction(()=>document.querySelector('[aria-label="패치 증강 순위 목록"]')?.textContent?.includes("과거 증강"));
    expect(await page.$eval('[aria-label="패치별 증강 순위"]',n=>n.textContent)).toContain("(추정)");
    const rows=await page.$$eval('[aria-label="패치 증강 순위 목록"] > li',nodes=>nodes.map(n=>n.textContent));expect(rows[1]).toContain("0.00%");expect(rows[2]).toContain("미제공");
    await page.select('select[aria-label="증강 순위 등급"]',"gold");expect(await page.$$eval('[aria-label="패치 증강 순위 목록"] > li',nodes=>nodes.length)).toBe(1);
    await page.type('input[aria-label="순위 증강 검색"]',"없는증강");await page.waitForFunction(()=>document.querySelector('[aria-label="패치별 증강 순위"]')?.textContent?.includes("조건에 맞는 증강이 없습니다"));
    await page.focus('[aria-label="패치별 증강 순위"] [role="status"] button');await page.keyboard.press("Enter");await page.waitForSelector('[aria-label="패치 증강 순위 목록"] > li');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.$eval('[aria-label="패치 증강 순위 목록"]',n=>getComputedStyle(n).gridTemplateColumns.split(" ").length)).toBe(1);
    expect(await page.$$eval('[aria-label="패치별 증강 순위"] input,[aria-label="패치별 증강 순위"] select',nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44))).toBe(true);
    await page.screenshot({path:`tmp/lol-mayhem-review/patch-rankings-${width}x${height}.png`,fullPage:true});
    await page.goto(`${base}/rankings-error`,{waitUntil:"networkidle0"});await page.click('[aria-label="증바람 보기"] button:nth-child(2)');await page.waitForSelector('[aria-label="패치별 증강 순위"] [role="alert"]');
    await page.click('[aria-label="패치별 증강 순위"] [role="alert"] button');await page.waitForSelector('[aria-label="패치 증강 순위 목록"] > li');
    expect(errors).toEqual([]);await page.close();
  });
  it("느린 과거 패치 응답이 새 패치 순위를 덮어쓰지 않는다",async()=>{
    const page=await browser.newPage();const started=new Promise<void>(resolve=>server.once("delayed-rankings-started",resolve));const sent=new Promise<void>(resolve=>server.once("delayed-rankings-sent",resolve));
    await page.goto(`${base}/rankings-race`,{waitUntil:"networkidle0"});await page.click('[aria-label="증바람 보기"] button:nth-child(2)');await page.waitForSelector('[aria-label="패치 증강 순위 목록"] > li');
    await page.select('select[aria-label="증강 순위 패치"]',"26.20");await started;await page.select('select[aria-label="증강 순위 패치"]',"26.21");
    await page.waitForFunction(()=>document.querySelector('[aria-label="패치 증강 순위 목록"]')?.textContent?.includes("현재 증강"));await sent;await page.waitForNetworkIdle({idleTime:500});
    expect(await page.$eval('[aria-label="패치 증강 순위 목록"]',n=>n.textContent)).not.toContain("과거 증강");await page.close();
  });

  it("도감이 없어도 패치 순위를 독립적으로 제공한다",async()=>{
    const page=await browser.newPage();await page.goto(`${base}/rankings-no-catalog`,{waitUntil:"networkidle0"});
    await page.click('[aria-label="증바람 보기"] button:first-child');await page.waitForSelector('[aria-label="패치 증강 순위 목록"] > li');
    expect(await page.$eval('[aria-label="패치별 증강 순위"]',n=>n.textContent)).toContain("모든 챔피언을 합친 통계");
    expect(await page.$('[role="alert"]')).toBeNull();await page.close();
  });

  it.each([[375,667],[390,844],[430,932],[1440,900]])("%ix%i에서 비활성·삭제 조회·검색·페이지 이동·재시도가 동작한다",async(width,height)=>{
    const page=await browser.newPage();await page.setViewport({width,height});const errors:string[]=[];page.on("pageerror",e=>errors.push(String(e)));let requests=0;page.on("request",r=>{if(r.url().includes("/mayhem/archive?"))requests++;});
    const press=(label:string)=>page.$$eval('button',(buttons,text)=>(buttons as HTMLButtonElement[]).find(b=>b.textContent?.trim().startsWith(text))!.click(),label);
    await page.goto(`${base}/archive`,{waitUntil:"networkidle0"});expect(requests).toBe(0);
    await press("조합·증강 상태");await page.waitForSelector('[aria-label="보존 조합 목록"] > li');expect(requests).toBe(1);
    await press("비활성");await page.waitForFunction(()=>document.querySelector('[aria-label="보존 조합 목록"]')?.textContent?.includes("비활성 증강"));
    await press("삭제");await page.waitForFunction(()=>document.querySelector('[aria-label="보존 조합 목록"]')?.textContent?.includes("삭제된 증강"));
    await press("증강 상태");await page.waitForSelector('[aria-label="보존 증강 목록"] > li');
    expect(await page.$eval('[aria-label="보존 증강 목록"]',n=>n.textContent)).toContain("26.18");
    await press("사용 중");await page.waitForFunction(()=>document.querySelectorAll('[aria-label="보존 증강 목록"] > li').length===50);
    await press("다음");await page.waitForFunction(()=>document.querySelectorAll('[aria-label="보존 증강 목록"] > li').length===2);await press("이전");await page.waitForFunction(()=>document.querySelectorAll('[aria-label="보존 증강 목록"] > li').length===50);
    await page.type('[aria-label="보존 증강 검색"]',"없는이름");await page.waitForFunction(()=>document.querySelector('[aria-label="증강·조합 상태 조회"]')?.textContent?.includes("해당 조건의 자료가 없습니다"));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.$$eval('[aria-label="자료 상태 필터"] button',nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44))).toBe(true);
    await page.screenshot({path:`tmp/lol-mayhem-review/archive-${width}x${height}.png`,fullPage:true});
    await page.goto(`${base}/archive-error`,{waitUntil:"networkidle0"});await press("조합·증강 상태");await page.waitForSelector('[role="alert"]');await press("다시 시도");await page.waitForSelector('[aria-label="보존 조합 목록"] > li');expect(errors).toEqual([]);await page.close();
  });
  it("느린 비활성 응답이 삭제 필터를 덮지 않는다",async()=>{
    const page=await browser.newPage();const press=(label:string)=>page.$$eval('button',(buttons,text)=>(buttons as HTMLButtonElement[]).find(b=>b.textContent?.trim().startsWith(text))!.click(),label);
    await page.goto(`${base}/archive-race`,{waitUntil:"networkidle0"});await press("조합·증강 상태");await page.waitForSelector('[aria-label="보존 조합 목록"] > li');
    const started=new Promise<void>(resolve=>server.once("delayed-archive-started",resolve));const sent=new Promise<void>(resolve=>server.once("delayed-archive-sent",resolve));await press("비활성");await started;await press("삭제");await page.waitForFunction(()=>document.querySelector('[aria-label="보존 조합 목록"]')?.textContent?.includes("삭제된 증강"));await sent;await page.waitForNetworkIdle();expect(await page.$eval('[aria-label="보존 조합 목록"]',n=>n.textContent)).not.toContain("비활성 증강");await page.close();
  });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 새 패치 자료 전에는 직전 패치 티어·조합을 기준 패치와 함께 보여준다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    await page.goto(`${base}/fallback`, { waitUntil: "networkidle0" });
    await openChampionPicker(page);
    expect(await page.evaluate(() => document.body.innerText)).toContain("티어순 · 26.20 기준");
    await page.evaluate(() => [...document.querySelectorAll("button")].find(node => node.textContent === "조합·증강 상태")?.click());
    await page.waitForFunction(() => document.body.innerText.includes("기준 패치 26.20 (새 패치 자료 준비 중)"));
    await page.waitForFunction(() => !document.body.innerText.includes("자료를 불러오지 못했습니다") && document.querySelectorAll("li").length > 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/fallback-${width}x${height}.png`, fullPage: true });
    await page.close();
  });
});
