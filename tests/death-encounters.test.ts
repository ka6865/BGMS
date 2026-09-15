import { describe, expect, it } from "vitest";
import { extractDeathEncounters } from "@/lib/pubg/deathEncounters";

const subject = { name: "Me", accountId: "account.subject", teamId: 1 };
const actor = (name: string, accountId: string, teamId = 2) => ({ name, accountId, teamId });
const v2 = (overrides: Record<string, unknown> = {}) => ({
  _T: "LogPlayerKillV2",
  _D: "2026-08-27T00:00:05.000Z",
  victim: subject,
  killer: actor("Killer", "account.killer"),
  finisher: actor("Finisher", "account.finisher"),
  dBNOMaker: actor("Knocker", "account.knocker"),
  killerDamageInfo: { weaponId: "Item_Weapon_A" },
  finishDamageInfo: { weaponId: "Item_Weapon_B" },
  dBNODamageInfo: { weaponId: "Item_Weapon_C" },
  ...overrides,
});

describe("extractDeathEncounters", () => {
  it("keeps killer, finisher, and knocker as separate roles with role-specific weapons", () => {
    const result = extractDeathEncounters({
      matchId: "match-1",
      platform: "steam",
      subjectAccountId: "account.subject",
      events: [v2()],
    });
    expect(result).toEqual([
      expect.objectContaining({ role: "killer", targetAccountId: "account.killer", weapon: "Item_Weapon_A" }),
      expect.objectContaining({ role: "finisher", targetAccountId: "account.finisher", weapon: "Item_Weapon_B" }),
      expect.objectContaining({ role: "knocker", targetAccountId: "account.knocker", weapon: "Item_Weapon_C" }),
    ]);
    expect(result.every((entry) => entry.eventAt === "2026-08-27T00:00:05.000Z")).toBe(true);
  });

  it("deduplicates a repeated event but preserves duplicate accounts in distinct roles", () => {
    const sameAccount = v2({
      finisher: actor("Killer", "account.killer"),
      dBNOMaker: actor("Killer", "account.killer"),
    });
    const result = extractDeathEncounters({
      matchId: "match-1",
      platform: "kakao",
      subjectAccountId: "account.subject",
      events: [sameAccount, sameAccount],
    });
    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.role)).toEqual(["killer", "finisher", "knocker"]);
  });

  it("supports the legacy killer-only event and ignores subject mismatch", () => {
    const result = extractDeathEncounters({
      matchId: "match-1",
      platform: "steam",
      subjectAccountId: "account.subject",
      events: [
        { _T: "LogPlayerKill", _D: "2026-08-27T00:00:01Z", victim: subject, killer: actor("Legacy", "account.legacy") },
        { ...v2(), victim: actor("Other", "account.other") },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "killer", targetAccountId: "account.legacy" });
  });

  it("excludes self, bots, environment, suicide, teamkill, and same-team actors", () => {
    const valid = v2({ _D: "2026-08-27T00:00:01Z" });
    const result = extractDeathEncounters({
      matchId: "match-1",
      platform: "steam",
      subjectAccountId: "account.subject",
      events: [
        valid,
        v2({ _D: "2026-08-27T00:00:02Z", killer: actor("Bot", "ai.bot"), finisher: null, dBNOMaker: null }),
        v2({ _D: "2026-08-27T00:00:03Z", killer: actor("Teammate", "account.teammate", 1), finisher: null, dBNOMaker: null }),
        v2({ _D: "2026-08-27T00:00:04Z", isSuicide: true, finisher: null, dBNOMaker: null }),
        v2({ _D: "2026-08-27T00:00:05Z", teamKillers_AccountId: ["account.killer"], finisher: null, dBNOMaker: null }),
        v2({ _D: "2026-08-27T00:00:06Z", killer: { name: "World" }, finisher: null, dBNOMaker: null }),
        v2({ _D: "2026-08-27T00:00:07Z", killer: subject, finisher: null, dBNOMaker: null }),
      ],
    });
    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.eventAt)).toEqual(["2026-08-27T00:00:01.000Z", "2026-08-27T00:00:01.000Z", "2026-08-27T00:00:01.000Z"]);
  });

  it("returns null weapon when no attacker weapon evidence exists", () => {
    const { killer, finisher, dBNOMaker, killerDamageInfo, finishDamageInfo, dBNODamageInfo, ...withoutWeapons } = v2({ _D: "2026-08-27T00:00:08Z" });
    const result = extractDeathEncounters({
      matchId: "match-1",
      platform: "steam",
      subjectAccountId: "account.subject",
      events: [{ ...withoutWeapons, killer, finisher, dBNOMaker }],
    });
    expect(result.every((entry) => entry.weapon === null)).toBe(true);
  });

  it("rejects invalid identities and public hashed account ids", () => {
    expect(() => extractDeathEncounters({ matchId: "", platform: "steam", subjectAccountId: "account.subject", events: [] })).toThrow();
    expect(() => extractDeathEncounters({ matchId: "match-1", platform: "x" as "steam", subjectAccountId: "account.subject", events: [] })).toThrow();
    expect(() => extractDeathEncounters({ matchId: "match-1", platform: "steam", subjectAccountId: "a".repeat(32), events: [] })).toThrow();
  });
});

describe('기절 후 소생한 상대 기록',()=>{
 it('반복 기절 시각을 유지하고 사망 부속 기절을 중복 표시하지 않는다',()=>{
  const victim={name:'Me',accountId:'account.me',teamId:1};
  const attacker={name:'Them',accountId:'account.them',teamId:2};
  const events=[
   {_T:'LogPlayerMakeGroggy',_D:'2026-09-13T00:00:01Z',victim,attacker},
   {_T:'LogPlayerRevive',_D:'2026-09-13T00:00:10Z',victim},
   {_T:'LogPlayerMakeGroggy',_D:'2026-09-13T00:00:20Z',victim,attacker},
   {_T:'LogPlayerKillV2',_D:'2026-09-13T00:00:30Z',victim,killer:attacker,dBNOMaker:attacker},
  ];
  const rows=extractDeathEncounters({matchId:'match-1',platform:'steam',subjectAccountId:'account.me',events});
  expect(rows.filter(e=>e.role==='knocker').map(e=>e.eventAt)).toEqual(['2026-09-13T00:00:01.000Z','2026-09-13T00:00:20.000Z']);
  expect(rows.filter(e=>e.role==='killer')).toHaveLength(1);
 });
 it('사망하지 않은 기절만으로도 상대를 보존하며 팀원을 제외한다',()=>{
  const victim={name:'Me',accountId:'account.me',teamId:1};
  const rows=extractDeathEncounters({matchId:'match-1',platform:'steam',subjectAccountId:'account.me',events:[
   {_T:'LogPlayerMakeGroggy',_D:'2026-09-13T00:00:01Z',victim,attacker:{name:'Enemy',accountId:'account.enemy',teamId:2}},
   {_T:'LogPlayerMakeGroggy',_D:'2026-09-13T00:00:10Z',victim,attacker:{name:'Friend',accountId:'account.friend',teamId:1}},
  ]});
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({role:'knocker',eventKind:'knock',targetAccountId:'account.enemy'});
 });
});
