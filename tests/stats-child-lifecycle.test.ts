import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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

describe("owned child lifecycle", () => {
  it("awaits the real child exit after SIGKILL fallback", async () => {
    const child = new FakeChild();

    await terminateOwnedChild(child as never, 12345);

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(137);
  }, 7_000);
});
