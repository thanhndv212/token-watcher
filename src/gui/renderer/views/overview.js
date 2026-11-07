/**
 * Overview — one screen answering "where do I stand right now?":
 * headroom on every quota window, last-7-day spend vs the 7 before, daily
 * spend by source, and a short list of observations computed from the data.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt, charts } = TW;
  const ui = TW.ui;
  TW.views = TW.views || {};

  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

  function sumBuckets(days) {
    const out = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
    for (const d of days)
      for (const k of Object.keys(out)) out[k] += (d.tokens && d.tokens[k]) || 0;
    return out;
  }

  function errorsAndDiagnostics(ctx, page) {
    const q = ctx.S.quota;
    if (!q) return;
    for (const message of q.historyDiagnostics || []) page.appendChild(ui.notice("info", message));
    for (const err of q.errors || [])
      page.appendChild(ui.notice("warning", (err.label ? err.label + ": " : "") + err.message));
  }

  function heroCard(t) {
    if (!t)
      return ui.card(
        { title: "Estimated spend · last 7 days", className: "hero" },
        ui.loading("Reading local usage…"),
      );
    const last7 = t.daily.slice(-7);
    const prev7 = t.daily.slice(-14, -7);
    const spend = sum(last7, (d) => d.costUsd);
    const prior = sum(prev7, (d) => d.costUsd);
    const share = t.totals.pricedShare;
    return ui.card(
      { title: "Estimated spend · last 7 days", className: "hero" },
      el(
        "div",
        { className: "hero-row" },
        el(
          "div",
          {},
          el("div", { className: "hero-value" }, fmt.usd(spend)),
          el(
            "div",
            { className: "hero-foot" },
            ui.deltaBadge(fmt.delta(spend, prior), "vs prior 7 days"),
            prior === 0 && spend > 0
              ? el("span", { className: "muted" }, "No spend in the prior 7 days")
              : null,
          ),
        ),
        charts.sparkline(
          t.daily.slice(-14).map((d) => d.costUsd),
          { width: 120, height: 40 },
        ),
      ),
      el(
        "div",
        { className: "card-note" },
        share == null
          ? "No local usage recorded yet."
          : (share >= 0.995
              ? "All tokens have a known price"
              : "Priced tokens are " + fmt.pct(share) + " of the total") +
              "; local stores on this machine only.",
      ),
    );
  }

  function kpis(t) {
    if (!t) return null;
    const last7 = t.daily.slice(-7);
    const prev7 = t.daily.slice(-14, -7);
    const spark = (f) => t.daily.slice(-14).map(f);
    const tok = sum(last7, (d) => d.totalTokens);
    const tokPrev = sum(prev7, (d) => d.totalTokens);
    const resp = sum(last7, (d) => d.responses);
    const respPrev = sum(prev7, (d) => d.responses);
    const cache = TW.cacheReadShare(sumBuckets(last7));
    const cachePrev = TW.cacheReadShare(sumBuckets(prev7));
    const perResp = resp > 0 ? tok / resp : null;
    const perRespPrev = respPrev > 0 ? tokPrev / respPrev : null;
    return ui.kpiRow([
      {
        label: "Tokens · 7d",
        value: fmt.compact(tok),
        delta: fmt.delta(tok, tokPrev),
        spark: spark((d) => d.totalTokens),
      },
      {
        label: "Responses · 7d",
        value: fmt.integer(resp),
        delta: fmt.delta(resp, respPrev),
        spark: spark((d) => d.responses),
      },
      {
        label: "Cache-read share",
        value: fmt.pct(cache),
        sub: cachePrev == null ? "of input-side tokens" : "prior 7d: " + fmt.pct(cachePrev),
        title: "Cache reads ÷ (input + cache read + cache write)",
      },
      {
        label: "Tokens / response",
        value: perResp == null ? TW.NA : fmt.compact(perResp),
        delta: perResp != null && perRespPrev != null ? fmt.delta(perResp, perRespPrev) : null,
      },
    ]);
  }

  function headroomCard(ctx) {
    const q = ctx.S.quota;
    const action = ui.button("All quota →", () => ctx.go("quota"), { small: true, kind: "ghost" });
    if (!q)
      return ui.card(
        { title: "Quota headroom", actions: action },
        ui.empty("◔", "No quota data loaded", "Click Refresh to fetch quota status"),
      );
    const rows = ctx.quota.quotaWindows(q.entries || []);
    if (!rows.length) {
      return ui.card(
        { title: "Quota headroom", actions: action },
        ui.empty(
          null,
          (q.entries || []).length
            ? "No percentage-based quota windows"
            : "No quota providers detected",
          "Balances and other values are listed under Quota.",
        ),
      );
    }
    const list = el("div", { className: "headroom" });
    for (const r of rows.slice(0, 6)) {
      const sev = TW.severity(r.used);
      list.appendChild(
        el(
          "div",
          { className: "headroom-row" },
          el(
            "div",
            { className: "headroom-head" },
            el(
              "span",
              { className: "headroom-name", title: r.title + (r.tag ? " · " + r.tag : "") },
              r.title,
              r.tag ? el("span", { className: "muted" }, " · " + r.tag) : null,
            ),
            sev.key !== "ok" ? ui.pill(sev.key, sev.label) : null,
            el("span", { className: "headroom-pct" }, Math.round(r.used) + "%"),
          ),
          charts.meter(r.used, { label: r.title + " " + r.tag }),
          el(
            "div",
            { className: "headroom-foot" },
            el("span", {}, Math.round(100 - r.used) + "% left"),
            ctx.quota.countdown(r.entry.resetTimeIso, "resets in "),
          ),
        ),
      );
    }
    return ui.card(
      {
        title: "Quota headroom",
        subtitle:
          "Most-used windows first" + (rows.length > 6 ? " · " + rows.length + " total" : ""),
        actions: action,
      },
      list,
    );
  }

  function dailyCard(t) {
    if (!t) return null;
    const useCost = t.totals.costUsd > 0;
    const series = TW.SOURCES.filter((s) => t.bySource[s.key].totalTokens > 0);
    const data = t.daily.map((d) => ({
      key: d.day,
      label: fmt.dayLabel(d.day),
      values: Object.fromEntries(
        series.map((s) => [
          s.key,
          useCost ? d.bySource[s.key].costUsd : d.bySource[s.key].totalTokens,
        ]),
      ),
      raw: d,
    }));
    const format = useCost ? (v) => fmt.usd(v, { compact: true }) : fmt.compact;
    return ui.chartCard({
      title: (useCost ? "Daily spend" : "Daily tokens") + " · 30 days",
      subtitle: useCost
        ? "Estimated, stacked by source"
        : "No priced usage yet; showing tokens by source",
      legend: series,
      chart: () =>
        charts.columns({
          data,
          series,
          format,
          emphasizeLast: true,
          xTick: (d, i, n) => ((n - 1 - i) % 7 === 0 ? fmt.shortDate(d.raw.startMs) : null),
          footer: (d) =>
            fmt.integer(d.raw.responses) +
            " responses · " +
            fmt.integer(d.raw.sessions) +
            " sessions",
        }),
      table: () =>
        charts.table(
          [
            { key: "day", label: "Day" },
            ...series.map((s) => ({
              key: s.key,
              label: s.label,
              numeric: true,
              format: (v) => format(v),
            })),
            { key: "total", label: "Total", numeric: true, format: (v) => format(v) },
          ],
          data
            .slice()
            .reverse()
            .map((d) => ({
              day: d.label,
              ...d.values,
              total: Object.values(d.values).reduce((a, b) => a + b, 0),
            })),
          { limit: 10 },
        ),
    });
  }

  /** Deterministic observations — every sentence is a direct read of the numbers shown. */
  function insightsList(ctx, t) {
    const out = [];
    const S = ctx.S;
    const triggered = ((S.budget && S.budget.results) || []).filter((r) => r.triggered);
    if (triggered.length)
      out.push({
        kind: "critical",
        text:
          triggered.length +
          " budget alert" +
          (triggered.length > 1 ? "s" : "") +
          " triggered: " +
          triggered.map((r) => r.rule.name).join(", ") +
          ".",
        action: ["View alerts", () => ctx.go("alerts")],
      });
    if (S.quota) {
      for (const r of ctx.quota.quotaWindows(S.quota.entries || [])) {
        if (r.used < 75) break;
        const left = fmt.countdown(r.entry.resetTimeIso);
        out.push({
          kind: r.used >= 90 ? "critical" : "warning",
          text:
            r.title +
            (r.tag ? " · " + r.tag : "") +
            " is at " +
            Math.round(r.used) +
            "% used" +
            (left ? "; it resets in " + left + "." : "."),
        });
      }
    }
    if (!t) return out;
    for (const u of t.unavailable || [])
      out.push({
        kind: "warning",
        text:
          (TW.SOURCE_BY_KEY[u.source] || { label: u.source }).label +
          " usage could not be read: " +
          u.reason,
      });
    const total = t.totals.totalTokens;
    if (total <= 0) {
      out.push({ kind: "info", text: "No local usage in the last 30 days." });
      return out;
    }
    if (t.totals.pricedShare != null && t.totals.pricedShare < 0.95)
      out.push({
        kind: "warning",
        text:
          fmt.pct(1 - t.totals.pricedShare) +
          " of tokens have no known price, so estimated spend is a lower bound.",
        action: ["Add prices", () => ctx.go("usage")],
      });
    const last7 = sum(t.daily.slice(-7), (d) => d.costUsd);
    const prev7 = sum(t.daily.slice(-14, -7), (d) => d.costUsd);
    const change = fmt.delta(last7, prev7);
    if (change != null && Math.abs(change) >= 0.25)
      out.push({
        kind: "info",
        text:
          "Spend is " +
          (change > 0 ? "up " : "down ") +
          fmt.pct(Math.abs(change)) +
          " on the prior 7 days (" +
          fmt.usd(prev7) +
          " → " +
          fmt.usd(last7) +
          ").",
      });
    const busiest = t.daily.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a));
    out.push({
      kind: "info",
      text:
        "Busiest day: " +
        fmt.dayLabel(busiest.day) +
        " with " +
        fmt.compact(busiest.totalTokens) +
        " tokens, " +
        fmt.pct(busiest.totalTokens / total) +
        " of the 30 days.",
    });
    let peak = { d: 0, h: 0, v: -1 };
    t.hourOfWeek.forEach((row, d) => row.forEach((v, h) => v > peak.v && (peak = { d, h, v })));
    const weekday = sum(t.hourOfWeek.slice(0, 5), (row) => sum(row, (v) => v));
    out.push({
      kind: "info",
      text:
        "Peak hour: " +
        fmt.WEEKDAYS[peak.d] +
        " " +
        fmt.hourLabel(peak.h) +
        "–" +
        fmt.hourLabel((peak.h + 1) % 24) +
        " local. Weekdays carry " +
        fmt.pct(weekday / total) +
        " of tokens.",
    });
    const sources = TW.SOURCES.map((s) => ({ ...s, ...t.bySource[s.key] })).filter(
      (s) => s.totalTokens > 0,
    );
    if (sources.length > 1) {
      const top = sources.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a));
      const costShare = t.totals.costUsd > 0 ? top.costUsd / t.totals.costUsd : null;
      out.push({
        kind: "info",
        text:
          top.label +
          " produced " +
          fmt.pct(top.totalTokens / total) +
          " of tokens" +
          (costShare != null ? " and " + fmt.pct(costShare) + " of estimated spend." : "."),
      });
    }
    const topModel = t.models.find((m) => m.costUsd != null && m.costUsd > 0);
    if (topModel && t.totals.costUsd > 0)
      out.push({
        kind: "info",
        text:
          topModel.modelID +
          " accounts for " +
          fmt.pct(topModel.costUsd / t.totals.costUsd) +
          " of estimated spend (" +
          fmt.usd(topModel.costUsd) +
          ").",
      });
    const cache = TW.cacheReadShare(t.totals.tokens);
    if (cache != null)
      out.push({
        kind: "info",
        text: "Cache reads are " + fmt.pct(cache) + " of input-side tokens over 30 days.",
      });
    return out;
  }

  function insightsCard(ctx, t) {
    const items = insightsList(ctx, t);
    if (!items.length) return null;
    return ui.card(
      { title: "Insights", subtitle: "Read directly from the numbers above; nothing is predicted" },
      el(
        "ul",
        { className: "insights" },
        items.map((i) =>
          el(
            "li",
            { className: "insight insight-" + i.kind },
            el(
              "span",
              { className: "insight-icon", "aria-hidden": "true" },
              i.kind === "critical" ? "▲" : i.kind === "warning" ? "●" : "→",
            ),
            el("span", { className: "insight-text" }, i.text),
            i.action
              ? el("button", { className: "link-btn", onClick: i.action[1] }, i.action[0])
              : null,
          ),
        ),
      ),
    );
  }

  TW.views.overview = {
    label: "Overview",
    icon: "◉",
    title: "Overview",
    enter(ctx) {
      ctx.load.timeline(30);
    },
    refresh(ctx) {
      return ctx.load.timeline(30, true);
    },
    render(ctx, page) {
      errorsAndDiagnostics(ctx, page);
      const tl = ctx.S.timelines[30];
      const t = tl && tl.data;
      if (tl && tl.error && !t)
        page.appendChild(ui.notice("warning", "Usage timeline unavailable: " + tl.error));
      page.appendChild(
        el(
          "div",
          { className: "grid grid-overview" },
          el("div", { className: "stack" }, heroCard(t), kpis(t)),
          headroomCard(ctx),
          dailyCard(t),
          insightsCard(ctx, t),
        ),
      );
    },
  };
})();
