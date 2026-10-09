import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): any };
const action = yaml.load(readFileSync(join(process.cwd(), ".github/actions/pubg-retention-batch/action.yml"), "utf8"));
const verify = action.runs.steps.find((step: any) => step.name === "Verify uploaded backup bytes before deletion");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function readback(error = "", failures = 0, payload = "matching", status = 1) {
  const directory = mkdtempSync(join(tmpdir(), "retention readback "));
  directories.push(directory);
  const uploaded = join(directory, "uploaded");
  mkdirSync(uploaded);
  writeFileSync(join(directory, "backup.enc"), "encrypted-fixture");
  writeFileSync(join(uploaded, "backup.enc"), payload === "mismatched" ? "different-bytes" : "encrypted-fixture");
  const archive = join(directory, "uploaded.zip");
  const zipped = spawnSync("zip", ["-q", archive, "backup.enc"], { cwd: uploaded, encoding: "utf8" });
  expect(zipped.status, zipped.stderr).toBe(0);
  if (payload === "invalid") writeFileSync(archive, "not-a-zip");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", `
    gh() {
      printf '%s\n' "$*" >> "$MOCK_CALLS"
      local attempt
      attempt=$(wc -l < "$MOCK_CALLS")
      if [ "$attempt" -le "$MOCK_FAILURES" ]; then
        printf 'partial-download'
        printf '%s PRIVATE_SENTINEL\n' "$MOCK_ERROR" >&2
        return "$MOCK_STATUS"
      fi
      cat "$MOCK_ARCHIVE"
    }
    timeout() { shift; "$@"; }
    sleep() { printf '%s\n' "$1" >> "$MOCK_SLEEPS"; }
    ${verify.run}
    printf 'PROOF_VERIFIED\n'
  `], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, GITHUB_REPOSITORY: "fixture/repo", OP_ARTIFACT_ID: "42",
      OP_BATCH_DIRECTORY: directory, MOCK_ARCHIVE: archive, MOCK_CALLS: join(directory, "calls"),
      MOCK_SLEEPS: join(directory, "sleeps"), MOCK_ERROR: error, MOCK_FAILURES: String(failures), MOCK_STATUS: String(status) },
  });
  const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n");
  expect(calls.every(call => /^api (?:--method GET )?repos\/fixture\/repo\/actions\/artifacts\/42\/zip$/.test(call))).toBe(true);
  return { result, calls, directory };
}

describe("retention artifact readback", () => {
  it("즉시 다운로드가 성공하면 비교를 마치고 재시도하지 않는다", () => {
    const { result, calls } = readback();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PROOF_VERIFIED");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["gh: Not Found (HTTP 404)", 1],
    ["gh: Too Many Requests (HTTP 429)", 1],
    ["gh: Bad Gateway (HTTP 502)", 1],
    ["connection reset by peer", 1],
    ["", 124],
  ])("일시적 오류 %s 뒤 성공하면 다운로드·해제·비교를 모두 통과한다", (error, status) => {
    const { result, calls, directory } = readback(error, 1, "matching", status);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PROOF_VERIFIED");
    expect(calls).toHaveLength(2);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_SENTINEL");
    expect(readFileSync(join(directory, "readback", "backup.enc"), "utf8")).toBe("encrypted-fixture");
  });

  it("404가 계속되면 세 번까지만 읽고 검증 이후 단계에 도달하지 않는다", () => {
    const { result, calls, directory } = readback("gh: Not Found (HTTP 404)", 99);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("PROOF_VERIFIED");
    expect(calls).toHaveLength(3);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_SENTINEL");
    expect(readFileSync(join(directory, "sleeps"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it.each([401, 403, 410])("영구 HTTP %s 오류는 재시도하지 않는다", code => {
    const { result, calls } = readback(`gh: Failed (HTTP ${code})`, 99);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("PROOF_VERIFIED");
    expect(calls).toHaveLength(1);
  });

  it.each(["invalid", "mismatched"])("다운로드 성공 뒤 %s 백업은 재시도나 검증 우회 없이 차단한다", payload => {
    const { result, calls } = readback("", 0, payload);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("PROOF_VERIFIED");
    expect(calls).toHaveLength(1);
  });
});
