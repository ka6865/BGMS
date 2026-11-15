import { describe, expect, it } from "vitest";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import { getExtendedCapacity, getMagazineKind, getSupportedSlots, getWeaponBaseCapacity, isAttachmentCompatible, resolveOfficialWeaponId, simulateWeapon, type SimulatorAttachment } from "@/lib/weapons/simulator";
import officialWeapons from "./fixtures/catalog/simulator-weapons.json";
import storedAttachments from "./fixtures/catalog/simulator-attachments.json";

const official = (key: string) => officialWeapons.find((item) => item.key === key) as OfficialItem;
const part = (name: string, slot: string, values: Partial<SimulatorAttachment> = {}): SimulatorAttachment => ({ id: name, name, slot, vertical_recoil: 0, horizontal_recoil: 0, reload_speed: 0, ...values });

describe("공식 무기 연결", () => {
  it("공식 별칭 key를 내부 ID로 연결하고 제거되거나 없는 무기를 대체하지 않는다", () => {
    const weapons = [{ id: "ar_aug", name: "AUG" }, { id: "ar_m416", name: "M416" }];
    expect(resolveOfficialWeaponId({ ...official("m416"), key: "aug_a3", name: "표시 이름 변경" }, weapons)).toBe("ar_aug");
    expect(resolveOfficialWeaponId({ ...official("m416"), key: "lynx_amr", name: "M416" }, weapons)).toBeNull();
    expect(resolveOfficialWeaponId({ ...official("m416"), key: "new", name: "없는 무기" }, weapons)).toBeNull();
  });
  it("미등록 key는 유일한 정확한 이름만 허용한다", () => {
    const item = { ...official("m416"), key: "new" };
    expect(resolveOfficialWeaponId(item, [{ id: "one", name: "M416" }, { id: "two", name: "M416" }])).toBeNull();
    expect(resolveOfficialWeaponId(item, [{ id: "one", name: "m416" }])).toBe("one");
  });
});

describe("무기별 공식 파츠 호환", () => {
  it("실제 저장된 파츠 ID·이름으로 M416의 다섯 슬롯과 공식 호환 파츠를 제공한다", () => {
    const compatible = storedAttachments.filter((attachment) => isAttachmentCompatible(official("m416"), attachment));
    const excluded = new Set(["cheek_pad", "folding_stock", "sight_8x"]);
    expect(compatible.map((attachment) => attachment.id)).toEqual(storedAttachments.filter((attachment) => !excluded.has(attachment.id)).map((attachment) => attachment.id));
    expect(getSupportedSlots(official("m416"), storedAttachments)).toEqual(["muzzle", "grip", "sight", "magazine", "stock"]);
  });
  it("저장 ID를 연결해도 무기별 공식 목록과 슬롯 제한을 우회하지 않는다", () => {
    const compensator = storedAttachments.find((attachment) => attachment.id === "ar_compensator")!;
    const magazine = storedAttachments.find((attachment) => attachment.id === "ar_eqd_magazine")!;
    const scope = storedAttachments.find((attachment) => attachment.id === "sight_8x")!;
    expect(isAttachmentCompatible(official("groza"), compensator)).toBe(false);
    expect(isAttachmentCompatible(official("kar98k"), compensator)).toBe(false);
    expect(isAttachmentCompatible(official("p90"), magazine)).toBe(false);
    const smg = { ...official("m416"), official: { addOnGroup: { categories: [{ name: "탄창", addOns: [{ name: "대용량 퀵드로우 탄창(SMG, 권총)" }] }] } } };
    expect(isAttachmentCompatible(smg, magazine)).toBe(false);
    expect(isAttachmentCompatible(official("m416"), { ...compensator, slot: "grip", name: "수직 손잡이" })).toBe(false);
    expect(isAttachmentCompatible(official("m416"), { ...magazine, id: "unknown_magazine" })).toBe(false);
    expect(isAttachmentCompatible(official("m416"), scope)).toBe(false);
    expect(isAttachmentCompatible(official("kar98k"), scope)).toBe(true);
  });
  it("AKM 손잡이와 Groza 보정기, AR의 SR 보정기를 차단한다", () => {
    expect(isAttachmentCompatible(official("akm"), part("수직 손잡이", "grip"))).toBe(false);
    expect(isAttachmentCompatible(official("groza"), part("보정기(AR)", "muzzle"))).toBe(false);
    expect(isAttachmentCompatible(official("groza"), part("소음기(AR)", "muzzle"))).toBe(true);
    expect(isAttachmentCompatible(official("m416"), part("보정기(SR)", "muzzle"))).toBe(false);
    expect(isAttachmentCompatible(official("m416"), part("보정기 (AR)", "muzzle"))).toBe(true);
    expect(isAttachmentCompatible(official("m416"), part("보정기", "muzzle"))).toBe(false);
  });
  it("미확인 괄호 수식어를 버려 다른 파츠로 인정하지 않는다", () => {
    expect(isAttachmentCompatible(official("m416"), part("중량형 개머리판(SR)", "stock"))).toBe(false);
    expect(isAttachmentCompatible(official("m416"), part("중량형 개머리판", "stock"))).toBe(true);
    expect(isAttachmentCompatible(official("m416"), part("보정기(AR, SR)", "muzzle"))).toBe(false);
    expect(isAttachmentCompatible(official("m416"), part("수직 손잡이(미확인)", "grip"))).toBe(false);
    expect(simulateWeapon("ar_m416", official("m416"), [part("중량형 개머리판(SR)", "stock", { vertical_recoil: -20 })]).verticalRecoil).toBe(100);
  });
  it("조준경 배율과 특수 무기 슬롯을 공식 목록으로 제한한다", () => {
    expect(isAttachmentCompatible(official("m416"), part("8배율 스코프", "sight"))).toBe(false);
    expect(isAttachmentCompatible(official("kar98k"), part("8배율 스코프", "sight"))).toBe(true);
    const parts = [part("탄띠 (SG, SR, Win94)", "stock"), part("레드 도트 사이트", "sight"), part("대용량 탄창(AR)", "magazine")];
    expect(getSupportedSlots(official("win94"), parts)).toEqual(["stock"]);
    expect(getSupportedSlots(official("p90"), parts)).toEqual([]);
    expect(getSupportedSlots(null, parts)).toEqual([]);
    expect(isAttachmentCompatible({ ...official("m416"), official: {} }, parts[0])).toBe(false);
  });
  it("M249 탄창과 개머리판을 허용하되 다른 슬롯으로 우회하지 못한다", () => {
    expect(isAttachmentCompatible(official("m249"), part("대용량 탄창(AR)", "magazine"))).toBe(true);
    expect(isAttachmentCompatible(official("m249"), part("전술 개머리판", "stock"))).toBe(true);
    expect(isAttachmentCompatible(official("m416"), part("수직 손잡이", "stock"))).toBe(false);
  });
});

describe("탄창 종류와 상대 지표 계산", () => {
  it("실제 AR 보정기와 탄창 ID로 M416의 보정 및 용량을 계산한다", () => {
    const parts = storedAttachments.filter((attachment) => ["ar_compensator", "ar_eqd_magazine"].includes(attachment.id));
    expect(simulateWeapon("ar_m416", official("m416"), parts)).toMatchObject({ capacity: 40, capacityDiff: 10, verticalRecoil: 85, horizontalRecoil: 90, reloadSpeed: 70 });
    const renamed = parts.map((attachment) => ({ ...attachment, name: "표시 이름 변경" }));
    expect(simulateWeapon("ar_m416", official("m416"), renamed)).toMatchObject({ capacity: 40, reloadSpeed: 70 });
  });
  it("퀵드로우는 기본 용량이며 대용량과 대용량 퀵드로우를 구분한다", () => {
    for (const [name, capacity] of [["퀵드로우 탄창(AR)", 30], ["대용량 탄창(AR)", 42], ["대용량 퀵드로우 탄창(AR)", 40]] as const) {
      expect(simulateWeapon("ar_m416", official("m416"), [part(name, "magazine")]).capacity).toBe(capacity);
    }
    expect(getMagazineKind("새 탄창")).toBeNull();
    expect(getExtendedCapacity("ar_m416", "quickdraw")).toBe(30);
  });
  it("공식 근거 없는 무기 용량을 무기 종류로 추정하지 않는다", () => {
    expect(getWeaponBaseCapacity("dmr_mini14")).toBeNull();
    expect(getExtendedCapacity("lmg_m249", "extended")).toBeNull();
    expect(simulateWeapon("dmr_mini14", official("mini14"), []).capacity).toBeNull();
  });
  it("호환되지 않는 파츠가 수치나 용량에 영향을 주지 않는다", () => {
    const result = simulateWeapon("ar_m416", official("m416"), [part("대용량 탄창(SMG)", "magazine", { reload_speed: -99 }), part("보정기(SR)", "muzzle", { vertical_recoil: -99 })]);
    expect(result).toMatchObject({ capacity: 30, reloadSpeed: 100, verticalRecoil: 100 });
  });
  it("하한 적용 후 표시 차이를 계산하고 비정상 보정을 무시한다", () => {
    const result = simulateWeapon("ar_m416", official("m416"), [part("수직 손잡이", "grip", { vertical_recoil: -90, horizontal_recoil: NaN }), part("전술 개머리판", "stock", { vertical_recoil: -40, reload_speed: -90 })]);
    expect(result).toMatchObject({ verticalRecoil: 30, verticalDiff: -70, horizontalRecoil: 100, horizontalDiff: 0, reloadSpeed: 40, reloadDiff: -60 });
  });
});
