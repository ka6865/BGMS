const DISPLAY_YEARS: Record<string, string> = { "15": "25", "16": "26" };

export function toDisplayPatch(gameVersion: string): string | null {
  const match = /^(15|16)\.(\d{1,2})(?:\.\d+)*$/.exec(gameVersion);
  if (!match || Number(match[2]) < 1) return null;
  return `${DISPLAY_YEARS[match[1]]}.${Number(match[2])}`;
}

export function toClientPatch(displayPatch: string): string | null {
  const match = /^(25|26)\.(\d{1,2})$/.exec(displayPatch);
  if (!match || Number(match[2]) < 1) return null;
  return `${Number(match[1]) - 10}.${Number(match[2])}`;
}

export function validatePatchMapping(gameVersion: string, displayPatch: string, versions: readonly string[]): boolean {
  const clientPatch = toClientPatch(displayPatch);
  return clientPatch !== null && toDisplayPatch(gameVersion) === toDisplayPatch(clientPatch)
    && versions.some(version => toDisplayPatch(version) === toDisplayPatch(clientPatch));
}
