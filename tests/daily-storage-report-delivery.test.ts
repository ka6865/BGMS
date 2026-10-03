import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireCompleteDailyReportR2Usage } from "@/lib/admin-agent/dailyStorageReport";
import { deliverDailyStorageReport } from "@/scripts/send_daily_storage_report";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));

describe("daily storage report delivery", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires connected and complete R2 measurements", () => {
    expect(() => requireCompleteDailyReportR2Usage({ configured: false, truncated: false, totalSizeBytes: 0 }))
      .toThrow("daily-storage-report-r2-unconfigured");
    expect(() => requireCompleteDailyReportR2Usage({ configured: true, truncated: true, totalSizeBytes: 100 }))
      .toThrow("daily-storage-report-r2-truncated");
    expect(() => requireCompleteDailyReportR2Usage({ configured: true, truncated: false, totalSizeBytes: NaN }))
      .toThrow("daily-storage-report-r2-usage-invalid");
    expect(requireCompleteDailyReportR2Usage({ configured: true, truncated: false, totalSizeBytes: 100 })).toBe(100);
  });

  it("uses bounded Discord delivery, requests a receipt, and returns only receipt metadata", async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { id: "message-123" } } as any);

    const receipt = await deliverDailyStorageReport("https://discord.example/webhook/secret", "report");

    expect(axios.post).toHaveBeenCalledWith(
      "https://discord.example/webhook/secret?wait=true",
      { content: "report", allowed_mentions: { parse: [] } },
      expect.objectContaining({ timeout: 8000, validateStatus: expect.any(Function) })
    );
    expect(receipt).toEqual({ status: 200, messageId: "message-123" });
  });

  it("rejects HTTP errors and missing receipts", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 429, data: { message: "rate limited" } } as any);
    await expect(deliverDailyStorageReport("https://discord.example/webhook/secret", "report"))
      .rejects.toThrow("daily-storage-report-discord-http-429");

    vi.mocked(axios.post).mockResolvedValueOnce({ status: 204, data: "" } as any);
    await expect(deliverDailyStorageReport("https://discord.example/webhook/secret", "report"))
      .rejects.toThrow("daily-storage-report-discord-receipt-missing");
  });

  it("propagates bounded request timeouts", async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error("timeout of 8000ms exceeded"));
    await expect(deliverDailyStorageReport("https://discord.example/webhook/secret", "report"))
      .rejects.toThrow("daily-storage-report-discord-timeout");
  });
});
