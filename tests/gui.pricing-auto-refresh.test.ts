import { afterEach, describe, expect, it, vi } from "vitest";

import { startPricingAutoRefresh } from "../src/gui/pricing-auto-refresh.js";
import type { PricingRefreshResult } from "../src/lib/modelsdev-pricing.js";

const HOUR = 60 * 60 * 1000;

function result(reason: string): PricingRefreshResult {
  return { attempted: false, updated: false, reason, state: { version: 1, updatedAt: 0 } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startPricingAutoRefresh", () => {
  it("checks after the first delay and then on every interval", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => result("fresh"));
    const onResult = vi.fn();
    const auto = startPricingAutoRefresh({
      refresh,
      onResult,
      firstDelayMs: 30_000,
      intervalMs: 6 * HOUR,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ reason: "fresh" }));

    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(refresh).toHaveBeenCalledTimes(4);

    auto.dispose();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("keeps the schedule after a failed check", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refresh = vi
      .fn<() => Promise<PricingRefreshResult>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(result("fresh"));
    const auto = startPricingAutoRefresh({ refresh, firstDelayMs: 10, intervalMs: HOUR });

    await vi.advanceTimersByTimeAsync(10);
    expect(warn).toHaveBeenCalledWith("Pricing auto-refresh failed:", "offline");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refresh).toHaveBeenCalledTimes(2);
    auto.dispose();
  });

  it("does nothing once disposed", async () => {
    const refresh = vi.fn(async () => result("fresh"));
    const auto = startPricingAutoRefresh({ refresh, firstDelayMs: HOUR });
    auto.dispose();
    expect(await auto.checkNow()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
