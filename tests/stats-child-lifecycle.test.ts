import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateOwnedChild } from "./helpers/statsBrowserHarness";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (signal === "SIGKILL") {
      setTimeout(() => {
        this.exitCode = 137;
        this.emit("exit", this.exitCode, signal);
      }, 10);
    }
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("owned child lifecycle", () => {
  it("awaits the real child exit after SIGKILL fallback", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let settled = false;

    const termination = terminateOwnedChild(child as never, 12345).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    await termination;
    expect(child.exitCode).toBe(137);
  });
});
