export interface PlayerMatchTeammate {
  name: string;
  account_id: string;
}

/** DB `teammates` 컬럼과 같은 형식(최대 8명, 이름 1~64자, PUBG 계정 ID)인지 확인한다. */
export function isPlayerMatchTeammateList(value: unknown): value is PlayerMatchTeammate[] {
  return Array.isArray(value) && value.length <= 8 && value.every((item) => {
    const entry = item as Partial<PlayerMatchTeammate> | null;
    return !!entry && typeof entry.name === "string" && entry.name.length >= 1 && entry.name.length <= 64
      && typeof entry.account_id === "string" && /^account\.[A-Za-z0-9_-]+$/.test(entry.account_id)
      && Object.keys(entry).length === 2;
  });
}
