import { describe, expect, it } from "vitest";
import {
  get3DReplayUnsupportedMessage,
  resolve3DMapCapability,
} from "@/lib/replay/mapCapabilities";

describe("3D 리플레이 맵 capability", () => {
  it("보유한 타일과 하이트맵이 있는 맵만 지원으로 해석한다", () => {
    expect(resolve3DMapCapability("Baltic_Main")?.id).toBe("Erangel");
    expect(resolve3DMapCapability("미라마")?.id).toBe("Miramar");
    expect(resolve3DMapCapability("Neon_Main")?.id).toBe("Rondo");
  });

  it("미지원 맵을 다른 지도 지형으로 대체하지 않고 차단 메시지를 만든다", () => {
    expect(resolve3DMapCapability("사녹")).toBeNull();
    expect(resolve3DMapCapability("Savage_Main")).toBeNull();
    expect(get3DReplayUnsupportedMessage("사녹")).toBe(
      "사녹 맵은 현재 3D 리플레이를 지원하지 않습니다. 2D 리플레이를 이용해 주세요.",
    );
  });
});
