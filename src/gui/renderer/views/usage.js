/**
 * Usage — where tokens and estimated spend went: trend, mix, rhythm, models.
 *
 * "This machine" reads the local stores through tokens:timeline (one pass,
 * bucketed by local day and hour-of-week, with an equal-length previous period
 * for deltas). "All machines" shows the merged export from tokens:merged.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt, charts } = TW;
  const ui = TW.ui;
  TW.views = TW.views || {};

  const RANGES = [7, 14, 30, 90];

  function sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
  }

  function toolbar(ctx) {
    const S = ctx.S;
    return el(
      "div",
      { className: "toolbar" },
      ui.segmented(
        [
          { value: "local", label: "This machine" },
          { value: "merged", label: "All machines" },
        ],
        S.usageScope,
        (v) => {
          S.usageScope = v;
          ctx.renderView();
          TW.views.usage.enter(ctx, {});
        },
        { small: true, label: "Scope" },
      ),
      S.usageScope === "local"
        ? ui.segmented(
            RANGES.map((d) => ({ value: d, label: d + "d", title: "Last " + d + " days" })),
            S.usageDays,
            (v) => {
              S.usageDays = v;
              ctx.renderView();
              TW.views.usage.enter(ctx, {});
            },
            { small: true, label: "Range" },
          )
        : null,
      el("span", { className: "toolbar-spacer" }),
      ui.button(
        "↗ Sync & push",
        async () => {
          try {
            const r = await ctx.api.tokens.syncExportAndPush();
            TW.toast(r && r.pushed ? "Synced & pushed" : "Exported (push skipped)", "success");
            if (S.usageScope === "merged") ctx.load.merged();
          } catch (e) {
            TW.toast(e.message, "error");
          }
        },
        { small: true, title: "Export this machine's usage and push it to the sync remote" },
      ),
    );
  }

  // ── KPIs ───────────────────────────────────────────────────────────────
  function kpis(t) {
    const p = t.previous || {};
    const spark = (pick) => t.daily.map(pick);
    const tokPerResp = t.totals.responses ? t.totals.totalTokens / t.totals.responses : null;
    const prevTokPerResp = p.responses ? p.totalTokens / p.responses : null;
    return ui.kpiRow([
      {
        label: "Est. spend",
        value: fmt.usd(t.totals.costUsd),
        delta: fmt.delta(t.totals.costUsd, p.costUsd),
        spark: spark((d) => d.costUsd),
        title: "Estimated from local pricing; compared with the previous " + t.days + " days",
      },
      {
        label: "Tokens",
        value: fmt.compact(t.totals.totalTokens),
        delta: fmt.delta(t.totals.totalTokens, p.totalTokens),
        spark: spark((d) => d.totalTokens),
      },
      {
        label: "Responses",
        value: fmt.integer(t.totals.responses),
        delta: fmt.delta(t.totals.responses, p.responses),
        spark: spark((d) => d.responses),
      },
      {
        label: "Tokens / response",
        value: tokPerResp == null ? TW.NA : fmt.compact(tokPerResp),
        delta: tokPerResp != null && prevTokPerResp ? fmt.delta(tokPerResp, prevTokPerResp) : null,
        sub: fmt.integer(t.totals.sessions) + " sessions",
      },
    ]);
  }

  // ── Daily trend ────────────────────────────────────────────────────────
  function trendCard(ctx, t) {
    const S = ctx.S;
    const metric = S.usageMetric === "cost" && t.totals.costUsd > 0 ? "cost" : "tokens";
    const series =
      metric === "tokens"
        ? TW.TOKEN_TYPES.filter((k) => (t.totals.tokens[k.key] || 0) > 0)
        : TW.SOURCES.filter((s) => t.bySource[s.key].costUsd > 0);
    const data = t.daily.map((d) => ({
      key: d.day,
      label: fmt.dayLabel(d.day),
      values: Object.fromEntries(
        series.map((s) => [
          s.key,
          metric === "tokens" ? d.tokens[s.key] || 0 : d.bySource[s.key].costUsd,
        ]),
      ),
      raw: d,
    }));
    const format = metric === "cost" ? (v) => fmt.usd(v, { compact: true }) : fmt.compact;
    const every = t.days <= 14 ? 2 : t.days <= 30 ? 7 : 14;
    const active = t.daily.filter((d) => d.responses > 0).length;
    return ui.chartCard({
      title: metric === "cost" ? "Daily estimated spend" : "Daily tokens",
      subtitle:
        (metric === "cost" ? "Stacked by source" : "Stacked by token type") +
        " · active on " +
        active +
        " of " +
        t.days +
        " days",
      legend: series,
      actions:
        t.totals.costUsd > 0
          ? ui.segmented(
              [
                { value: "tokens", label: "Tokens" },
                { value: "cost", label: "Cost" },
              ],
              metric,
              (v) => {
                S.usageMetric = v;
                ctx.renderView();
              },
              { small: true, label: "Metric" },
            )
          : null,
      chart: () =>
        charts.columns({
          data,
          series,
          format,
          height: 180,
          emphasizeLast: true,
          xTick: (d, i, n) => ((n - 1 - i) % every === 0 ? fmt.shortDate(d.raw.startMs) : null),
          footer: (d) =>
            fmt.integer(d.raw.responses) +
            " responses · " +
            fmt.integer(d.raw.sessions) +
            " sessions",
        }),
      table: () =>
        charts.table(
          [
            { key: "day", label: "Day", sortValue: (r) => r.startMs },
            ...series.map((s) => ({
              key: s.key,
              label: s.label,
              numeric: true,
              format: (v) => format(v),
            })),
            { key: "total", label: "Total", numeric: true, format: (v) => format(v) },
            { key: "responses", label: "Resp.", numeric: true, format: fmt.integer },
          ],
          data.map((d) => ({
            day: d.label,
            startMs: d.raw.startMs,
            ...d.values,
            total: sum(Object.values(d.values)),
            responses: d.raw.responses,
          })),
          { sortKey: "day", sortDir: "desc", limit: 14 },
        ),
    });
  }

  // ── Mix and split ──────────────────────────────────────────────────────
  function tokenMixCard(tokens, subtitle) {
    const parts = TW.TOKEN_TYPES.map((k) => ({
      label: k.label,
      value: (tokens && tokens[k.key]) || 0,
      color: k.color,
    }));
    const total = sum(parts.map((p) => p.value));
    const share = TW.cacheReadShare(tokens);
    return ui.card(
      { title: "Token mix", subtitle },
      total > 0
        ? charts.segmented(parts, { format: fmt.compact })
        : el("div", { className: "muted" }, "No tokens recorded in this range."),
      share != null
        ? el(
            "div",
            { className: "card-note" },
            fmt.pct(share) +
              " of prompt tokens were served from cache" +
              (share >= 0.5 ? " — caching is doing most of the work." : "."),
          )
        : null,
    );
  }

  function sourceSplitCard(t) {
    const rows = TW.SOURCES.map((s) => ({ ...s, ...t.bySource[s.key] })).filter(
      (s) => s.totalTokens > 0 || s.responses > 0,
    );
    const totalTok = t.totals.totalTokens;
    return ui.card(
      { title: "By source", subtitle: "Share of tokens · estimated spend" },
      rows.length
        ? charts.rankedBars(
            rows.map((s) => ({
              key: s.key,
              label: s.label,
              value: s.totalTokens,
              valueText: fmt.compact(s.totalTokens),
              sub:
                fmt.usd(s.costUsd) +
                " · " +
                fmt.integer(s.responses) +
                " responses · " +
                fmt.integer(s.sessions) +
                " sessions",
              color: s.color,
            })),
            { total: totalTok, format: fmt.compact },
          )
        : el("div", { className: "muted" }, "No source reported usage in this range."),
    );
  }

  // ── Rhythm ─────────────────────────────────────────────────────────────
  function rhythmCard(t) {
    const values = t.hourOfWeek;
    const total = sum(values.flat());
    if (!total)
      return ui.card(
        { title: "When you work" },
        el("div", { className: "muted" }, "No dated usage in this range."),
      );
    let peak = { r: 0, c: 0, v: -1 };
    values.forEach((row, r) => row.forEach((v, c) => v > peak.v && (peak = { r, c, v })));
    const byHour = Array.from({ length: 24 }, (_, h) => sum(values.map((row) => row[h])));
    const workHours = sum(byHour.slice(9, 18));
    const weekend = sum(values[5]) + sum(values[6]);
    return ui.chartCard({
      title: "When you work",
      subtitle: "Tokens by weekday and hour, local time",
      chart: () =>
        charts.heatmap({
          rows: fmt.WEEKDAYS,
          cols: Array.from({ length: 24 }, (_, h) => h),
          values,
          format: fmt.compact,
          title: (r, c) =>
            fmt.WEEKDAYS[r] + " · " + fmt.hourLabel(c) + "–" + fmt.hourLabel((c + 1) % 24),
          extraRows: (r, c) => [
            { label: "Responses", value: fmt.integer(t.hourOfWeekResponses[r][c]) },
          ],
          colTick: (c) => (c % 6 === 0 ? fmt.hourLabel(c) : null),
        }),
      table: () =>
        charts.table(
          [
            { key: "hour", label: "Hour", sortValue: (r) => r.h },
            ...fmt.WEEKDAYS.map((d, i) => ({
              key: "d" + i,
              label: d,
              numeric: true,
              format: fmt.compact,
            })),
          ],
          byHour.map((_, h) => ({
            hour: fmt.hourLabel(h),
            h,
            ...Object.fromEntries(values.map((row, i) => ["d" + i, row[h]])),
          })),
          { sortKey: "hour", sortDir: "asc" },
        ),
      note:
        "Busiest hour: " +
        fmt.WEEKDAYS[peak.r] +
        " " +
        fmt.hourLabel(peak.c) +
        ". " +
        fmt.pct(workHours / total) +
        " of tokens fell between 09:00 and 18:00; " +
        fmt.pct(weekend / total) +
        " on weekends.",
    });
  }

  // ── Models ─────────────────────────────────────────────────────────────
  function modelsCards(ctx, t) {
    const models = t.models.slice();
    const priced = models.filter((m) => m.costUsd != null).sort((a, b) => b.costUsd - a.costUsd);
    const unpriced = models
      .filter((m) => m.costUsd == null)
      .sort((a, b) => b.totalTokens - a.totalTokens);
    const label = (m) =>
      m.modelID + " · " + (TW.SOURCE_BY_KEY[m.source] || { label: m.source }).label;
    const color = (m) => (TW.SOURCE_BY_KEY[m.source] || { color: "var(--muted)" }).color;

    const top = priced.slice(0, 8).map((m) => ({
      key: m.source + m.providerID + m.modelID,
      label: label(m),
      value: m.costUsd,
      sub: fmt.compact(m.totalTokens) + " tokens · " + fmt.integer(m.responses) + " responses",
      color: color(m),
    }));
    const rest = sum(priced.slice(8).map((m) => m.costUsd));
    if (rest > 0)
      top.push({
        key: "other",
        label: "Other " + (priced.length - 8) + " models",
        value: rest,
        color: "var(--muted)",
        muted: true,
      });
    for (const m of unpriced.slice(0, 4))
      top.push({
        key: "u" + m.source + m.providerID + m.modelID,
        label: label(m),
        value: 0,
        valueText: TW.NA,
        sub: fmt.compact(m.totalTokens) + " tokens · not priced",
        badge: { kind: "warning", label: "No price" },
        action: {
          label: "Add price",
          onClick: () => ctx.modals.addPricing(m.providerID, m.modelID),
        },
        color: color(m),
      });

    const costCard = ui.card(
      {
        title: "Spend by model",
        subtitle: priced.length
          ? "Estimated · top " +
            Math.min(8, priced.length) +
            " of " +
            priced.length +
            " priced models"
          : "No priced models in this range",
      },
      top.length
        ? charts.rankedBars(top, { format: (v) => fmt.usd(v), total: t.totals.costUsd })
        : el("div", { className: "muted" }, "No model usage recorded."),
      unpriced.length
        ? el(
            "div",
            { className: "card-note" },
            unpriced.length +
              " model(s) without pricing (" +
              fmt.compact(sum(unpriced.map((m) => m.totalTokens))) +
              " tokens) are excluded from spend.",
          )
        : null,
    );

    const tableCard = ui.card(
      {
        title: "All models",
        subtitle: "Click a column to sort; click an unpriced row to add a price",
      },
      charts.table(
        [
          { key: "modelID", label: "Model", className: "cell-strong" },
          {
            key: "source",
            label: "Source",
            format: (v) => (TW.SOURCE_BY_KEY[v] || { label: v }).label,
          },
          { key: "totalTokens", label: "Tokens", numeric: true, format: fmt.compact },
          {
            key: "cache",
            label: "Cache",
            numeric: true,
            format: (v) => (v == null ? TW.NA : fmt.pct(v)),
            title: () => "Cache-read share of prompt tokens",
          },
          { key: "responses", label: "Resp.", numeric: true, format: fmt.integer },
          {
            key: "perResp",
            label: "Tok/resp",
            numeric: true,
            format: (v) => (v == null ? TW.NA : fmt.compact(v)),
          },
          {
            key: "costUsd",
            label: "Cost",
            numeric: true,
            format: (v) => (v == null ? TW.NA : fmt.usd(v)),
            sortValue: (r) => (r.costUsd == null ? -1 : r.costUsd),
          },
        ],
        models.map((m) => ({
          ...m,
          cache: TW.cacheReadShare(m.tokens),
          perResp: m.responses ? m.totalTokens / m.responses : null,
        })),
        {
          sortKey: "totalTokens",
          sortDir: "desc",
          limit: 12,
          rowClass: (r) => (r.costUsd == null ? "row-unpriced" : ""),
          onRowClick: (r) => {
            if (r.costUsd == null) ctx.modals.addPricing(r.providerID, r.modelID);
          },
        },
      ),
    );
    return [costCard, tableCard];
  }

  function sessionsCard(ctx) {
    const agg = (ctx.S.usageAggregates[ctx.S.usageDays] || {}).aggregate;
    if (!agg) return null;
    const rows = (agg.bySession || []).filter(
      (s) => (s.costUsd || 0) > 0 || (s.messageCount || 0) > 0,
    );
    if (!rows.length) return null;
    return ui.card(
      { title: "Top sessions", subtitle: "Last " + ctx.S.usageDays + " days · this machine" },
      charts.table(
        [
          {
            key: "title",
            label: "Session",
            className: "cell-strong",
            format: (v, r) => v || String(r.sessionID || "").slice(0, 10),
          },
          { key: "tok", label: "Tokens", numeric: true, format: fmt.compact },
          { key: "messageCount", label: "Msgs", numeric: true, format: fmt.integer },
          { key: "costUsd", label: "Cost", numeric: true, format: (v) => fmt.usd(v || 0) },
        ],
        rows.map((s) => ({ ...s, tok: TW.sumTokens(s.tokens) })),
        { sortKey: "costUsd", sortDir: "desc", limit: 10 },
      ),
    );
  }

  // ── Views ──────────────────────────────────────────────────────────────
  function renderLocal(ctx, page) {
    const S = ctx.S;
    const entry = S.timelines[S.usageDays];
    const t = entry && entry.data;
    if (entry && entry.error)
      page.appendChild(ui.notice("warning", "Usage unavailable: " + entry.error));
    if (!t) {
      page.appendChild(
        entry && entry.error
          ? tokenMixCard(null, "Unavailable")
          : ui.loading("Reading local usage…"),
      );
      if (!(entry && entry.error)) page.appendChild(tokenMixCard(null, "Loading"));
      return;
    }
    for (const u of t.unavailable || [])
      page.appendChild(
        ui.notice(
          "info",
          (TW.SOURCE_BY_KEY[u.source] || { label: u.source }).label + " unavailable: " + u.reason,
        ),
      );
    if (t.undatedResponses)
      page.appendChild(
        ui.notice(
          "info",
          fmt.integer(t.undatedResponses) +
            " responses had no timestamp and are excluded from charts.",
        ),
      );

    page.appendChild(kpis(t));
    if (t.totals.pricedShare != null && t.totals.pricedShare < 0.99)
      page.appendChild(
        el(
          "div",
          { className: "card-note" },
          "Spend covers " +
            fmt.pct(t.totals.pricedShare) +
            " of tokens; the rest belongs to models without a price.",
        ),
      );

    page.appendChild(el("div", { className: "grid grid-wide" }, trendCard(ctx, t)));
    page.appendChild(
      el(
        "div",
        { className: "grid grid-2" },
        tokenMixCard(t.totals.tokens, "All sources · last " + t.days + " days"),
        sourceSplitCard(t),
      ),
    );
    page.appendChild(el("div", { className: "grid grid-wide" }, rhythmCard(t)));
    page.appendChild(el("div", { className: "grid grid-2" }, ...modelsCards(ctx, t)));
    const sessions = sessionsCard(ctx);
    if (sessions) page.appendChild(sessions);
  }

  function renderMerged(ctx, page) {
    const S = ctx.S;
    const m = S.merged;
    if (S.mergedLoading && !m) {
      page.appendChild(ui.loading("Reading merged exports…"));
      page.appendChild(tokenMixCard(null, "Loading"));
      return;
    }
    if (!m || !m.totals) {
      page.appendChild(
        ui.empty(
          "⇄",
          "No merged usage yet",
          "Use Sync & push on each machine to build a combined view.",
        ),
      );
      page.appendChild(tokenMixCard(null, "All machines"));
      return;
    }
    const tokens = m.totals.tokens || {};
    page.appendChild(
      ui.kpiRow([
        { label: "Est. spend", value: fmt.usd(m.totals.costUsd || 0) },
        { label: "Tokens", value: fmt.compact(TW.sumTokens(tokens)) },
        { label: "Messages", value: fmt.integer(m.totals.messages || 0) },
        {
          label: "Cache-read share",
          value: TW.cacheReadShare(tokens) == null ? TW.NA : fmt.pct(TW.cacheReadShare(tokens)),
        },
      ]),
    );
    const rows = (m.byProviderModel || []).map((r) => ({ ...r, tok: TW.sumTokens(r.tokens) }));
    const byCost = rows.slice().sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
    page.appendChild(
      el(
        "div",
        { className: "grid grid-2" },
        tokenMixCard(tokens, "All machines · merged export"),
        ui.card(
          { title: "Spend by model", subtitle: "All machines" },
          byCost.length
            ? charts.rankedBars(
                byCost.slice(0, 8).map((r, i) => ({
                  key: r.provider + "/" + r.model,
                  label: r.model + " · " + TW.providerLabel(r.provider),
                  value: r.costUsd || 0,
                  sub: fmt.compact(r.tok) + " tokens",
                  color: "var(--s" + ((i % 5) + 1) + ")",
                })),
                { format: (v) => fmt.usd(v), total: m.totals.costUsd || 0 },
              )
            : el("div", { className: "muted" }, "No models in the merged export."),
        ),
      ),
    );
    page.appendChild(
      ui.card(
        { title: "Models across machines" },
        charts.table(
          [
            { key: "model", label: "Model", className: "cell-strong" },
            { key: "provider", label: "Provider", format: (v) => TW.providerLabel(v) },
            { key: "tok", label: "Tokens", numeric: true, format: fmt.compact },
            { key: "costUsd", label: "Cost", numeric: true, format: (v) => fmt.usd(v || 0) },
          ],
          rows,
          { sortKey: "costUsd", sortDir: "desc", limit: 15 },
        ),
      ),
    );
  }

  TW.views.usage = {
    label: "Usage",
    icon: "▤",
    title: "Usage",
    enter(ctx) {
      if (ctx.S.usageScope === "merged") return ctx.load.merged();
      ctx.load.timeline(ctx.S.usageDays);
      ctx.load.usageAggregate(ctx.S.usageDays);
    },
    refresh(ctx) {
      if (ctx.S.usageScope === "merged") return ctx.load.merged();
      return Promise.all([
        ctx.load.timeline(ctx.S.usageDays, true),
        ctx.load.usageAggregate(ctx.S.usageDays, true),
      ]);
    },
    render(ctx, page) {
      page.appendChild(toolbar(ctx));
      if (ctx.S.usageScope === "merged") renderMerged(ctx, page);
      else renderLocal(ctx, page);
    },
  };
})();
