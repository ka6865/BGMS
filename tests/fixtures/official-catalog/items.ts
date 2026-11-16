import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";

export const weapons: OfficialItem[] = [
  { key: "m416", name: "M416", updated: "2026-11-04", category: { key: "ar", name: "돌격소총" }, ammunition: "5.56mm", specs: {}, official: { addOnGroup: { categories: [{ name: "탄창", addOns: [{ name: "퀵 드로우 탄창" }] }] } } },
  { key: "akm", name: "AKM", updated: "2026-10-01", category: { key: "ar", name: "돌격소총" }, ammunition: "7.62mm", specs: {}, official: {} },
  { key: "mini14", name: "Mini14", updated: "2026-10-01", category: { key: "dmr", name: "지정사수소총" }, ammunition: "5.56mm", specs: {}, official: {} },
  { key: "legacy", name: "이전 저장 무기", updated: "2025-01-01", ammunition: null, specs: {}, official: {} },
];
export const vehicles: OfficialItem[] = [
  { key: "buggy", name: "버기", updated: "2026-10-01", category: { key: "land", name: "지상" }, ammunition: null, specs: {}, official: {} },
  { key: "boat", name: "보트", updated: "2026-10-01", category: { key: "water", name: "수상" }, ammunition: null, specs: {}, official: {} },
  { key: "legacy", name: "이전 저장 탈것", updated: "2025-01-01", ammunition: null, specs: {}, official: {} },
];
