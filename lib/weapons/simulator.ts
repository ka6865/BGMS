import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";

type WeaponIdentity = { id: string; name: string };
export interface SimulatorAttachment {
  id: string;
  name: string;
  slot: string | null;
  vertical_recoil: number;
  horizontal_recoil: number;
  reload_speed: number;
}

// 공식 key와 기존 BGMS ID의 명시적 연결. 이름이나 배열 순서로 다른 무기를 고르지 않는다.
const WEAPON_IDS: Record<string, string> = {
  m16a4: "ar_m16a4", m416: "ar_m416", "scar-l": "ar_scarl", g36c: "ar_g36c",
  qbz95: "ar_qbz", k2: "ar_k2", aug_a3: "ar_aug", famas_g2: "ar_famas",
  akm: "ar_akm", beryl_m762: "ar_beryl", mk47_mutant: "ar_mk47", groza: "ar_groza", ace32: "ar_ace32",
  mini14: "dmr_mini14", mk12: "dmr_mk12", sks: "dmr_sks", slr: "dmr_slr", mk14: "dmr_mk14",
  vss: "dmr_vss", dragunov: "dmr_dragunov", qbu: "dmr_qbu",
  tommy_gun: "smg_tommy", ump45: "smg_ump", micro_uzi: "smg_uzi", vector: "smg_vector",
  mp5k: "smg_mp5k", mp9: "smg_mp9", p90: "smg_p90", js9: "smg_js9", bizon: "smg_bizon",
  kar98k: "sr_kar98k", m24: "sr_m24", awm: "sr_awm", win94: "sr_win94", lynx_amr: "sr_lynx",
  s12k: "sg_s12k", s1897: "sg_s1897", s686: "sg_s686", dbs: "sg_dbs", o12: "sg_o12",
  m249: "lmg_m249", mg3: "lmg_mg3", rpd: "lmg_rpd",
};

export function resolveOfficialWeaponId(item: OfficialItem, weapons: readonly WeaponIdentity[]): string | null {
  const mapped = WEAPON_IDS[item.key];
  const matches = mapped
    ? weapons.filter((weapon) => weapon.id === mapped)
    : weapons.filter((weapon) => weapon.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase());
  return matches.length === 1 ? matches[0].id : null;
}

const SLOT_NAMES: Record<string, string> = { muzzle: "총구", grip: "손잡이", sight: "조준기", magazine: "탄창", stock: "개머리판" };
// 표시명이 다른 기존 DB 파츠는 ID로 연결하되 슬롯·총기 계열은 유지한다.
const ATTACHMENT_IDENTITIES: Record<string, { slot: string; name: string }> = {
  ar_compensator: { slot: "muzzle", name: "보정기(AR)" },
  ar_flashhider: { slot: "muzzle", name: "소염기(AR)" },
  ar_suppressor: { slot: "muzzle", name: "소음기(AR)" },
  muzzle_brake: { slot: "muzzle", name: "제동기(AR)" },
  ar_eqd_magazine: { slot: "magazine", name: "대용량 퀵드로우 탄창(AR)" },
  half_grip: { slot: "grip", name: "하프 그립" },
  light_grip: { slot: "grip", name: "라이트 그립" },
  thumb_grip: { slot: "grip", name: "엄지 그립" },
  heavy_stock: { slot: "stock", name: "중량형 개머리판" },
  scope_4x: { slot: "sight", name: "4배율 스코프" },
  sight_8x: { slot: "sight", name: "8배율 스코프" },
  sight_holographic: { slot: "sight", name: "홀로그램 조준기" },
};
type OfficialPart = { name: string };

function officialParts(item: OfficialItem | null | undefined, slot: string): OfficialPart[] {
  const group = item?.official?.addOnGroup as { categories?: { name?: string; addOns?: unknown[] }[] } | undefined;
  if (!Array.isArray(group?.categories)) return [];
  return group.categories.filter((group) => group.name === SLOT_NAMES[slot])
    .flatMap((group) => Array.isArray(group.addOns) ? group.addOns : [])
    .filter((part): part is OfficialPart => !!part && typeof part === "object" && typeof (part as OfficialPart).name === "string");
}

function partIdentity(name: string, slot: string): string {
  const normalized = name.toLowerCase().replace(/\s+/g, "");
  const match = /^([^()]+)\(([^()]+)\)$/.exec(normalized);
  if (!match) return normalized;
  const [, base, qualifier] = match;
  if (slot === "muzzle" || slot === "magazine") {
    // 공식 묶음과 확인된 기존 단축 표기만 연결한다. 혼합·미확인 수식어는 그대로 구분한다.
    const families: Record<string, string> = {
      ar: "ar", "ar,dmr": "ar",
      [slot === "muzzle" ? "ar,dmr,o12,s12k" : "ar,dmr,lmg,s12k"]: "ar",
      sr: "sr", "dmr,sr": "sr", smg: "smg", "smg,권총": "smg",
    };
    const family = families[qualifier.split(",").sort().join(",")];
    return family ? `${base}(${family})` : normalized;
  }
  if (slot === "stock" && (
    (base === "중량형개머리판" && qualifier.split(",").sort().join(",") === "ar,lmg,smg") ||
    (base === "접이식개머리판" && qualifier === "스콜피온,마이크로uzi,mp9")
  )) return base;
  return normalized;
}

function attachmentIdentity(attachment: SimulatorAttachment): string | null {
  if (!attachment.slot) return null;
  const identity = ATTACHMENT_IDENTITIES[attachment.id];
  if (identity && identity.slot !== attachment.slot) return null;
  return partIdentity(identity?.name ?? attachment.name, attachment.slot);
}

export function isAttachmentCompatible(item: OfficialItem | null | undefined, attachment: SimulatorAttachment): boolean {
  const identity = attachmentIdentity(attachment);
  return !!identity && officialParts(item, attachment.slot!).some((part) => partIdentity(part.name, attachment.slot!) === identity);
}

export function getSupportedSlots(item: OfficialItem | null | undefined, attachments: readonly SimulatorAttachment[]): string[] {
  return Object.keys(SLOT_NAMES).filter((slot) => attachments.some((part) => part.slot === slot && isAttachmentCompatible(item, part)));
}

// 공식 도감에는 장착 가능하다고 나오지만 BGMS 파츠 자료에 대응 항목이 없는 부착물. 장착 불가와 자료 누락을 구분해 안내한다.
export function getMissingOfficialParts(item: OfficialItem | null | undefined, attachments: readonly SimulatorAttachment[]): { slot: string; name: string }[] {
  return Object.keys(SLOT_NAMES).flatMap((slot) => {
    const known = new Set(attachments.filter((part) => part.slot === slot).map(attachmentIdentity));
    return officialParts(item, slot).filter((part) => !known.has(partIdentity(part.name, slot))).map((part) => ({ slot, name: part.name }));
  });
}

export const OFFICIAL_SPEC_KEYS = ["발 당 데미지", "초 당 데미지(DPS)", "연사속도", "안정성", "유효사거리", "탄속"] as const;
export function getOfficialSpec(item: OfficialItem | null | undefined, key: string): number | null {
  const value = Number(item?.specs?.[key]);
  return item?.specs?.[key] !== undefined && Number.isFinite(value) ? value : null;
}

// 공식 도감의 발 당 데미지는 막대 표시용이라 100에서 잘린다. 100은 실제 수치로 비교하지 않는다.
export function getOfficialDamage(item: OfficialItem | null | undefined): number | null {
  const damage = getOfficialSpec(item, "발 당 데미지");
  return damage !== null && damage < 100 ? damage : null;
}

export type MagazineKind = "quickdraw" | "extended" | "extendedQuickdraw";
export function getMagazineKind(name: string): MagazineKind | null {
  const base = name.replace(/\s+/g, "").split("(")[0];
  if (base === "대용량퀵드로우탄창") return "extendedQuickdraw";
  if (base === "대용량탄창") return "extended";
  if (base === "퀵드로우탄창") return "quickdraw";
  return null;
}

// shortcut: 공식 수치가 확인된 무기만 표시한다. 다른 무기는 공식 용량 근거를 확보한 뒤 추가한다.
export const CAPACITY_SOURCE = "https://pubg.com/en/news/1727";
const CAPACITIES: Record<string, { base: number; extended: number; extendedQuickdraw: number }> = {
  ar_m416: { base: 30, extended: 42, extendedQuickdraw: 40 },
};

export function getWeaponBaseCapacity(weaponId: string): number | null {
  return CAPACITIES[weaponId]?.base ?? null;
}

export function getExtendedCapacity(weaponId: string, kind: MagazineKind): number | null {
  const capacity = CAPACITIES[weaponId];
  if (!capacity) return null;
  return kind === "quickdraw" ? capacity.base : capacity[kind];
}

export function simulateWeapon(weaponId: string, item: OfficialItem | null | undefined, attachments: readonly SimulatorAttachment[]) {
  const parts = attachments.filter((part) => isAttachmentCompatible(item, part));
  const sum = (field: "vertical_recoil" | "horizontal_recoil" | "reload_speed") => parts.reduce((total, part) => total + (Number.isFinite(part[field]) ? part[field] : 0), 0);
  const verticalRecoil = Math.max(30, 100 + sum("vertical_recoil"));
  const horizontalRecoil = Math.max(30, 100 + sum("horizontal_recoil"));
  const reloadSpeed = Math.max(40, 100 + sum("reload_speed"));
  const base = getWeaponBaseCapacity(weaponId);
  const magazine = parts.find((part) => part.slot === "magazine");
  const kind = magazine ? getMagazineKind(ATTACHMENT_IDENTITIES[magazine.id]?.name ?? magazine.name) : null;
  const capacity = magazine ? (kind ? getExtendedCapacity(weaponId, kind) : null) : base;
  return { verticalRecoil, horizontalRecoil, reloadSpeed, capacity,
    verticalDiff: verticalRecoil - 100, horizontalDiff: horizontalRecoil - 100, reloadDiff: reloadSpeed - 100,
    capacityDiff: capacity !== null && base !== null ? capacity - base : null };
}
