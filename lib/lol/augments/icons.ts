export const LOL_AUGMENT_ICON_BUCKET = "lol-augment-icons";
export const MAX_LOL_AUGMENT_ICON_BYTES = 2 * 1024 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export const isPng = (bytes: Uint8Array) => bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
export const lolAugmentIconObject = (patch: string, icon: string) => `${patch}/${icon}`;

// 버전 고정 경로의 원본을 비공개 버킷에 복사한다. 하나라도 실패하면 예외를 던져 아이콘이 빠진 패치가 게시되지 않게 한다.
export async function syncLolAugmentIcons(patch: string, icons: string[], deps: {
  download: (url: string, maxBytes: number, check: (body: Buffer) => void) => Promise<Buffer>;
  upload: (path: string, body: Buffer) => Promise<void>;
}): Promise<number> {
  for (const icon of icons) {
    const body = await deps.download(`https://raw.communitydragon.org/${patch}/game/${icon}`, MAX_LOL_AUGMENT_ICON_BYTES, bytes => {
      if (!isPng(bytes)) throw new Error("source_invalid_icon");
    });
    await deps.upload(lolAugmentIconObject(patch, icon), body);
  }
  return icons.length;
}
