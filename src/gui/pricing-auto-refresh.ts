/**
 * Periodic pricing snapshot refresh for the long-running desktop app.
 *
 * The plugin and CLI check the models.dev snapshot once per process, which is
 * enough for short-lived processes but means a tray app open for weeks never
 * refreshes. This timer re-runs the same check every few hours with `recheck`:
 * nothing is fetched unless the snapshot is older than the configured
 * `pricingSnapshot.autoRefresh` days, attempts stay throttled, and a `bundled`
 * selection is never refreshed.
 */

import {
  maybeRefreshPricingSnapshot,
  type PricingRefreshResult,
} from "../lib/modelsdev-pricing.js";

export const PRICING_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PRICING_FIRST_CHECK_DELAY_MS = 30 * 1000;

export interface PricingAutoRefreshOptions {
  intervalMs?: number;
  firstDelayMs?: number;
  refresh?: () => Promise<PricingRefreshResult>;
  onResult?: (result: PricingRefreshResult) => void;
}

export interface PricingAutoRefresh {
  /** Run one check now; concurrent calls share the refresh in flight. */
  checkNow(): Promise<PricingRefreshResult | null>;
  dispose(): void;
}

export function startPricingAutoRefresh(opts: PricingAutoRefreshOptions = {}): PricingAutoRefresh {
  const intervalMs = opts.intervalMs ?? PRICING_RECHECK_INTERVAL_MS;
  const refresh =
    opts.refresh ?? (() => maybeRefreshPricingSnapshot({ recheck: true, reason: "status" }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const checkNow = async (): Promise<PricingRefreshResult | null> => {
    if (disposed) return null;
    try {
      const result = await refresh();
      if (!disposed) opts.onResult?.(result);
      return result;
    } catch (error) {
      // The bundled or last runtime snapshot stays in use; try again next time.
      console.warn("Pricing auto-refresh failed:", error instanceof Error ? error.message : error);
      return null;
    }
  };

  const schedule = (delayMs: number) => {
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void checkNow().finally(() => schedule(intervalMs));
    }, delayMs);
    // Never keep the process alive just for this timer.
    timer.unref?.();
  };

  schedule(opts.firstDelayMs ?? PRICING_FIRST_CHECK_DELAY_MS);

  return {
    checkNow,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
