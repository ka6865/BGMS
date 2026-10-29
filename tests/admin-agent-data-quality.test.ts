import { describe, expect, it } from "vitest";
import {
  auditProcessedTelemetryIdentity,
  buildProcessedTelemetryIdentityRepairPayload,
  findProcessedTelemetryIdentityMismatch,
  type ProcessedTelemetryIdentityAudit
} from "../lib/admin-agent/data-quality";

describe("Admin Agent 데이터 품질 감사", () => {
  it("row.player_id와 fullResult.stats.name 불일치를 identity mismatch로 분류한다", () => {
    const mismatch = findProcessedTelemetryIdentityMismatch({
      match_id: "match-1",
      platform: "steam",
      player_id: "kangheesung_",
      data: {
        fullResult: {
          player_id: "kangheesung_",
          platform: "steam",
          stats: { name: "OtherPlayer" }
        }
      }
    });

    expect(mismatch).toMatchObject({
      match_id: "match-1",
      platform: "steam",
      player_id: "kangheesung_",
      statsName: "otherplayer",
      reason: "row.player_id와 fullResult.stats.name 불일치",
      canDelete: true
    });
  });

  it("fullResult.player_id 불일치도 identity mismatch로 분류한다", () => {
    const mismatch = findProcessedTelemetryIdentityMismatch({
      match_id: "match-1",
      platform: "steam",
      player_id: "kangheesung_",
      data: {
        fullResult: {
          player_id: "otherplayer",
          platform: "steam",
          stats: { name: "KangHeeSung_" }
        }
      }
    });

    expect(mismatch).toMatchObject({
      embeddedPlayerId: "otherplayer",
      reason: "row.player_id와 fullResult.player_id 불일치",
      canDelete: true
    });
  });

  it("platform 컬럼이 없는 row는 mismatch여도 자동 삭제 후보에서 제외한다", () => {
    const mismatch = findProcessedTelemetryIdentityMismatch({
      match_id: "match-1",
      player_id: "kangheesung_",
      data: {
        fullResult: {
          player_id: "kangheesung_",
          platform: "steam",
          stats: { name: "OtherPlayer" }
        }
      }
    });

    expect(mismatch).toMatchObject({
      hasPlatformColumn: false,
      canDelete: false
    });
  });

  it("승인 payload는 삭제 후보를 targetLimit 안으로 제한하고 집계 오염 자동 삭제 금지를 명시한다", () => {
    const deletionTargets = Array.from({ length: 3 }, (_, index) => ({
      match_id: `match-${index}`,
      platform: "steam",
      player_id: `player_${index}`,
      statsName: "other",
      embeddedPlayerId: "other",
      resultPlatform: "steam",
      hasPlatformColumn: true,
      canDelete: true,
      reason: "row.player_id와 fullResult.stats.name 불일치"
    }));
    const audit: ProcessedTelemetryIdentityAudit = {
      mode: "dry-run",
      table: "processed_match_telemetry",
      recentDays: 2,
      maxRows: 1000,
      scannedRows: 1000,
      mismatchCount: 10,
      missingPlatformColumnRows: 0,
      deletionCandidateCount: 3,
      samples: deletionTargets.slice(0, 1),
      deletionTargets,
      truncated: false,
      generatedAt: "2026-06-11T00:00:00.000Z"
    };

    const payload = buildProcessedTelemetryIdentityRepairPayload(audit, 2);

    expect(payload.targetCount).toBe(2);
    expect(payload.targets).toHaveLength(2);
    expect(payload.warnings.join(" ")).toContain("연막/회복 집계값 오염 가능 row는 자동 삭제하지 않고 재분석으로 교체합니다.");
  });

  it("무거운 data 전체 대신 식별 경로만 작은 페이지로 읽고 created_at 인덱스 순서로 감사한다", async () => {
    const createdRows = Array.from({ length: 3 }, (_, index) => ({
      match_id: `match-${index}`,
      platform: "steam",
      player_id: `player_${index}`,
      created_at: `2026-10-29T0${index}:00:00.000Z`,
      updated_at: `2026-10-29T0${index}:00:00.000Z`
    }));
    const updatedOnlyRow = {
      match_id: "match-old",
      platform: "kakao",
      player_id: "player_old",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-10-29T05:00:00.000Z"
    };
    const paths: Record<string, Record<string, string | null>> = {
      "match-0": { statsName: "Player_0", embeddedPlayerId: "player_0", resultPlatform: "steam" },
      "match-1": { statsName: "Other", embeddedPlayerId: "player_1", resultPlatform: "steam" },
      "match-2": { statsName: null, embeddedPlayerId: null, resultPlatform: null },
      "match-old": { statsName: "player_old", embeddedPlayerId: "player_old", resultPlatform: "steam" }
    };
    const calls: Array<{ select: string; orders: string[]; range?: [number, number]; gte?: string; lt?: string; in?: string[] }> = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe("processed_match_telemetry");
        const call: (typeof calls)[number] = { select: "", orders: [] };
        calls.push(call);
        const builder: any = {
          select(columns: string) { call.select = columns; return builder; },
          order(column: string) { call.orders.push(column); return builder; },
          range(from: number, to: number) { call.range = [from, to]; return builder; },
          gte(column: string) { call.gte = column; return builder; },
          lt(column: string) { call.lt = column; return builder; },
          in(_column: string, values: string[]) { call.in = values; return builder; },
          then(resolve: (value: unknown) => unknown) {
            let data: unknown[];
            if (call.in) {
              data = [...createdRows, updatedOnlyRow]
                .filter(row => call.in!.includes(row.match_id))
                .map(row => ({ ...row, ...paths[row.match_id] }));
            } else {
              const source = call.orders[0] === "created_at" ? createdRows : [updatedOnlyRow];
              data = source.slice(call.range![0], call.range![1] + 1);
            }
            return Promise.resolve({ data, error: null }).then(resolve);
          }
        };
        return builder;
      }
    };

    const audit = await auditProcessedTelemetryIdentity(supabase, {
      recentDays: 2,
      maxRows: 1000,
      pageSize: 1000,
      targetLimit: 50
    });

    const keyCalls = calls.filter(call => !call.in);
    const pathCalls = calls.filter(call => call.in);
    expect(keyCalls.every(call => !call.select.includes("data"))).toBe(true);
    expect(pathCalls.every(call => !/(^|,\s*)data(,|$)/.test(call.select))).toBe(true);
    expect(pathCalls[0]?.select).toContain("statsName:data->fullResult->stats->>name");
    expect(keyCalls[0]).toMatchObject({ orders: ["created_at", "match_id", "player_id"], gte: "created_at", range: [0, 199] });
    expect(keyCalls.find(call => call.orders[0] === "updated_at")).toMatchObject({ gte: "updated_at", lt: "created_at" });
    expect(audit.scannedRows).toBe(4);
    expect(audit.mismatchCount).toBe(3);
    expect(audit.samples.map(sample => [sample.match_id, sample.reason])).toEqual([
      ["match-1", "row.player_id와 fullResult.stats.name 불일치"],
      ["match-2", "fullResult 없음"],
      ["match-old", "row.platform과 fullResult.platform 불일치"]
    ]);
  });
});
