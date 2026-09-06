import { describe, expect, it } from "vitest";
import {
  sanitizeUnsupportedAiSummaryBenchmarkLanguage as sanitize,
  type CanonicalDebateEvidenceMap,
} from "@/lib/pubg-analysis/aiSummaryDebate";

const neutral = "검증된 경기 지표를 바탕으로 분석합니다.";
const equalEvidence: CanonicalDebateEvidenceMap = {
  trade_success_rate: {
    user: { label: "복수 성공률", value: "33%" },
    benchmark: { label: "동일 티어 평균 복수 성공률", value: "33%" },
  },
  backup_latency: {
    user: { label: "백업 속도", value: "5.36s" },
    benchmark: { label: "동일 티어 평균 백업 속도", value: "5.36s" },
  },
};
const reportedProse = "듀오 모드 기준 복수 성공률 33% (모드·매치 유형·티어 기준 BGMS 표본 평균 [모드 duo · 매치 유형 competitive · 티어 B]; 해당 지표 n=36: 복수 성공률 33%. 백업 속도 5.36s (모드·매치 유형·티어 기준 BGMS 표본 평균 [모드 duo · 매치 유형 competitive · 티어 B]; 해당 지표 n=6: 백업 속도 5.36s.";

describe("readable AI coaching with verified evidence", () => {
  it("repairs the reported broken audit parentheses into complete coaching sentences without losing measurements", () => {
    const output = sanitize(reportedProse, equalEvidence, { allowedMode: "duo" });
    expect(output).not.toMatch(/BGMS|competitive|n\s*=|[()[\]]/);
    expect(output).toContain("복수 성공률은 33%");
    expect(output).toContain("비교 평균은 33%");
    expect(output).toContain("백업 속도는 5.36s이며, 비교 평균은 5.36s입니다.");
    expect(output).not.toMatch(/높|낮|느리|빠르/);
    expect(sanitize(output, equalEvidence, { allowedMode: "duo" })).toBe(output);
  });

  it("preserves actionable advice while removing the metric sample metadata", () => {
    const advice = "백업 과정에서 확실한 교전 정리 후 복구 성공률을 높여야 합니다.";
    const source = reportedProse.split(". 백업 속도")[0] + ". " + advice;
    const output = sanitize(source, equalEvidence, { allowedMode: "duo" });
    expect(output).toContain(advice);
    expect(output).not.toMatch(/BGMS|competitive|n\s*=/);
    expect(output).toContain("33%");
  });

  it("does not hide a different mode inside the removed comparison conditions", () => {
    expect(sanitize(reportedProse, equalEvidence, { allowedMode: "squad" })).toBe(neutral);
  });

  it("does not create measured or comparison prose when evidence is missing", () => {
    expect(sanitize(reportedProse, {}, { allowedMode: "duo" })).toBe(neutral);
    expect(sanitize("평균 화력은 비교 평균보다 높습니다.", {})).toBe(neutral);
  });

  it.each([
    ["평균 화력은 비교 평균보다 높습니다.", true],
    ["평균 화력은 비교 평균보다 낮습니다.", false],
    ["평균 화력은 비교 평균과 같습니다.", false],
    ["평균 화력은 비교 평균보다 높지 않습니다.", false],
    ["평균 화력보다 비교 평균이 높습니다.", false],
    ["비교 평균은 평균 화력보다 높습니다.", false],
    ["평균 화력은 비교 평균보다 압도적입니다.", false],
    ["평균 화력은 비교 평균보다 적극적으로 낮추지 않습니다.", false],
  ])("checks the subject and relationship rather than accepting a direction keyword: %s", (source, valid) => {
    const evidence = {
      damage_average: {
        user: { label: "평균 화력", value: "825" },
        benchmark: { label: "동일 티어 평균 화력", value: "682" },
      },
    };
    expect(sanitize(source, evidence)).toBe(valid ? source : neutral);
  });

  it.each([
    ["복수 성공률은 비교 평균과 같습니다.", true],
    ["복수 성공률은 비교 평균보다 낮습니다.", false],
    ["복수 성공률은 비교 평균보다 높습니다.", false],
  ])("does not call an equal result deficient: %s", (source, valid) => {
    expect(sanitize(source, equalEvidence)).toBe(valid ? source : neutral);
  });

  it.each([
    ["백업 속도는 비교 평균보다 빠릅니다.", true],
    ["백업 속도는 비교 평균보다 느립니다.", false],
  ])("checks duration comparison using measured seconds: %s", (source, valid) => {
    const evidence = {
      backup_latency: {
        user: { label: "백업 속도", value: "5.36s" },
        benchmark: { label: "동일 티어 평균 백업 속도", value: "8s" },
      },
    };
    expect(sanitize(source, evidence)).toBe(valid ? source : neutral);
  });
});
