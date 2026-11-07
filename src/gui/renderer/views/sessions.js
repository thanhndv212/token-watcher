/**
 * Sessions — the shape of work: how many sessions, how long, how heavy, and
 * (optionally) which quota windows they landed in and what they produced.
 *
 * Data comes from sessions:report, the same report as `token-watcher sessions`.
 * n/a always means "not available", never zero.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt, charts } = TW;
  const ui = TW.ui;
  TW.views = TW.views || {};

  const NA = TW.NA;
  const pctOrNa = (v) => (v == null ? NA : fmt.pct(v));
  const usdOrNa = (v) => (v == null ? NA : fmt.usd(v));
  const countOrNa = (v) => (v == null ? NA : fmt.integer(v));
  const BUCKETS = ["1-10", "11-50", "51-200", "201+"];
  const utcMinute = (ms) =>
    ms == null ? NA : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

  function sourceMeta(key) {
    return TW.SOURCE_BY_KEY[key] || { key, label: key, color: "var(--muted)" };
  }

  function controls(ctx) {
    const SS = ctx.S.sessions;
    const reload = () => ctx.load.sessions();
    return el(
      "div",
      { className: "toolbar" },
      ui.segmented(
        [7, 14, 28, 90].map((d) => ({ value: d, label: d + "d", title: "Last " + d + " days" })),
        SS.days,
        (v) => {
          SS.days = v;
          reload();
        },
        { small: true, label: "Range" },
      ),
      el(
        "span",
        { className: "toggle-label" },
        ui.toggleSwitch(
          SS.windows,
          (v) => {
            SS.windows = v;
            reload();
          },
          "Quota windows",
        ),
        "Quota windows",
      ),
      el(
        "span",
        { className: "toggle-label" },
        ui.toggleSwitch(
          SS.imports,
          (v) => {
            SS.imports = v;
            reload();
          },
          "Session Knowledge imports",
        ),
        "Session Knowledge imports",
      ),
      SS.loading ? el("span", { className: "muted" }, "Loading…") : null,
    );
  }

  function coverageCard(r) {
    const m = r.machine || {};
    return ui.card(
      {
        title: "Sources · last " + r.days + " days",
        subtitle: "Machine " + (m.machineId || "?") + (m.mapped ? "" : " (unmapped)"),
      },
      el(
        "div",
        { className: "coverage" },
        (r.coverage || []).map((c) => {
          const meta = sourceMeta(c.source);
          const detail =
            c.status === "read"
              ? fmt.integer(c.sessions) + " sessions, " + fmt.integer(c.responses) + " responses"
              : c.status === "not-found"
                ? "no local store found"
                : "unavailable: " + (c.reason || "read failed");
          return el(
            "div",
            { className: "coverage-row" },
            ui.pill(
              c.status === "read" ? "ok" : c.status === "not-found" ? "neutral" : "warning",
              meta.label,
            ),
            el("span", { className: "muted" }, detail),
          );
        }),
      ),
    );
  }

  function kpis(r) {
    const t = r.totals;
    return ui.kpiRow([
      {
        label: "Sessions",
        value: fmt.integer(t.sessions),
        sub: fmt.integer(t.responses) + " responses",
      },
      {
        label: "Tokens / session",
        value: t.sessions ? fmt.compact(t.totalTokens / t.sessions) : NA,
        sub: fmt.compact(t.totalTokens) + " total",
      },
      {
        label: "Cache-read share",
        value: pctOrNa(t.cacheReadShare),
        sub: "Subagents " + pctOrNa(t.subagentShare),
      },
      { label: "Est. cost", value: usdOrNa(t.costUsd), sub: "priced " + pctOrNa(t.pricedShare) },
    ]);
  }

  function weeklyCard(r) {
    const rows = (r.weekly || []).filter((w) => w.source !== "all");
    const weeks = [...new Set((r.weekly || []).map((w) => w.weekStart))].sort();
    const series = TW.SOURCES.filter((s) => rows.some((w) => w.source === s.key && w.sessions > 0));
    const extra = [...new Set(rows.map((w) => w.source))]
      .filter((k) => !TW.SOURCE_BY_KEY[k])
      .map((k, i) => ({ key: k, label: k, color: "var(--s" + (4 + (i % 2)) + ")" }));
    const allSeries = [...series, ...extra];
    const data = weeks.map((wk) => {
      const all = (r.weekly || []).find((w) => w.weekStart === wk && w.source === "all");
      return {
        key: wk,
        label: "Week of " + wk,
        values: Object.fromEntries(
          allSeries.map((s) => [
            s.key,
            (rows.find((w) => w.weekStart === wk && w.source === s.key) || {}).sessions || 0,
          ]),
        ),
        raw: all || {},
      };
    });
    return ui.chartCard({
      title: "Sessions per week",
      subtitle: "Weeks start Monday UTC · stacked by source",
      legend: allSeries,
      chart: () =>
        data.length
          ? charts.columns({
              data,
              series: allSeries,
              format: fmt.integer,
              height: 150,
              emphasizeLast: true,
              xTick: (d) => d.key.slice(5),
              footer: (d) =>
                d.raw.totalTokens != null
                  ? fmt.compact(d.raw.totalTokens) + " tokens · " + usdOrNa(d.raw.costUsd)
                  : null,
            })
          : el("div", { className: "muted" }, "No weekly data."),
      table: () =>
        charts.table(
          [
            { key: "weekStart", label: "Week" },
            {
              key: "source",
              label: "Source",
              format: (v) => (v === "all" ? "All" : sourceMeta(v).label),
            },
            { key: "sessions", label: "Sessions", numeric: true, format: fmt.integer },
            { key: "responses", label: "Resp.", numeric: true, format: fmt.integer },
            { key: "totalTokens", label: "Tokens", numeric: true, format: fmt.compact },
            { key: "cacheReadShare", label: "Cache", numeric: true, format: pctOrNa },
            { key: "costUsd", label: "Cost", numeric: true, format: usdOrNa },
          ],
          r.weekly || [],
          { sortKey: "weekStart", sortDir: "desc" },
        ),
    });
  }

  /** Session length (responses per session) against where the tokens went. */
  function lengthCard(r) {
    const all = (r.lengthBuckets || []).filter((b) => b.source === "all");
    const rows = BUCKETS.map(
      (b) =>
        all.find((x) => x.bucket === b) || { bucket: b, sessions: 0, totalTokens: 0, responses: 0 },
    );
    const sessTotal = rows.reduce((a, b) => a + (b.sessions || 0), 0);
    const tokTotal = rows.reduce((a, b) => a + (b.totalTokens || 0), 0);
    const long = rows.slice(2);
    const longSess = long.reduce((a, b) => a + (b.sessions || 0), 0);
    const longTok = long.reduce((a, b) => a + (b.totalTokens || 0), 0);
    const series = [
      { key: "sessions", label: "Share of sessions", color: "var(--s1)" },
      { key: "tokens", label: "Share of tokens", color: "var(--s2)" },
    ];
    const items = rows.flatMap((b) => [
      {
        key: b.bucket + "s",
        label: b.bucket + " responses",
        value: sessTotal ? (b.sessions || 0) / sessTotal : 0,
        valueText: fmt.pct(sessTotal ? (b.sessions || 0) / sessTotal : 0) + " of sessions",
        sub: fmt.integer(b.sessions || 0) + " sessions",
        color: "var(--s1)",
      },
      {
        key: b.bucket + "t",
        label: "",
        value: tokTotal ? (b.totalTokens || 0) / tokTotal : 0,
        valueText: fmt.pct(tokTotal ? (b.totalTokens || 0) / tokTotal : 0) + " of tokens",
        sub: fmt.compact(b.totalTokens || 0) + " tokens · " + usdOrNa(b.costUsd),
        color: "var(--s2)",
      },
    ]);
    return ui.chartCard({
      title: "Session length",
      subtitle: "Responses per session · share of sessions vs share of tokens",
      legend: series,
      chart: () =>
        el(
          "div",
          { className: "length-bars" },
          charts.rankedBars(items, { total: 0, format: (v) => fmt.pct(v) }),
        ),
      table: () =>
        charts.table(
          [
            { key: "bucket", label: "Responses", sortable: false },
            { key: "sessions", label: "Sessions", numeric: true, format: fmt.integer },
            { key: "totalTokens", label: "Tokens", numeric: true, format: fmt.compact },
            { key: "cacheReadShare", label: "Cache", numeric: true, format: pctOrNa },
            { key: "costUsd", label: "Cost", numeric: true, format: usdOrNa },
          ],
          rows,
          {},
        ),
      note:
        sessTotal && tokTotal
          ? "Sessions with more than 50 responses are " +
            fmt.pct(longSess / sessTotal) +
            " of sessions but " +
            fmt.pct(longTok / tokTotal) +
            " of tokens."
          : null,
    });
  }

  function scatterCard(r) {
    const pts = (r.sessions || []).filter((s) => s.responses > 0 && s.totalTokens > 0);
    if (pts.length < 3) return null;
    const series = TW.SOURCES.filter((s) => pts.some((p) => p.source === s.key));
    return ui.card(
      {
        title: "Session footprint",
        subtitle: "Each dot is one of the top " + pts.length + " sessions · log scales",
      },
      series.length > 1 ? charts.legend(series) : null,
      charts.scatter({
        points: pts.map((s) => ({
          x: s.responses,
          y: s.totalTokens,
          series: s.source,
          title: s.project || s.sessionID.slice(0, 12),
          rows: [
            { label: "Responses", value: fmt.integer(s.responses) },
            { label: "Tokens", value: fmt.compact(s.totalTokens) },
            { label: "Cache", value: pctOrNa(s.cacheReadShare) },
            { label: "Cost", value: usdOrNa(s.costUsd) },
            { label: "Model", value: (s.models[0] && s.models[0].model) || NA },
          ],
        })),
        series,
        xLabel: "Responses",
        yLabel: "Tokens",
        xFormat: fmt.compact,
        yFormat: fmt.compact,
        logX: true,
        logY: true,
        height: 200,
      }),
    );
  }

  function topSessionsCard(r) {
    return ui.card(
      {
        title: "Top " + r.sessions.length + " of " + fmt.integer(r.sessionCount) + " sessions",
        subtitle: "Start times in UTC",
      },
      charts.table(
        [
          { key: "source", label: "Source", format: (v) => sourceMeta(v).label },
          {
            key: "project",
            label: "Project",
            className: "cell-strong",
            format: (v, row) => v || row.sessionID.slice(0, 12),
          },
          { key: "startMs", label: "Start", format: utcMinute },
          { key: "model", label: "Model", format: (v) => v || NA },
          { key: "responses", label: "Resp.", numeric: true, format: fmt.integer },
          { key: "totalTokens", label: "Tokens", numeric: true, format: fmt.compact },
          { key: "cacheReadShare", label: "Cache", numeric: true, format: pctOrNa },
          {
            key: "costUsd",
            label: "Cost",
            numeric: true,
            format: usdOrNa,
            sortValue: (row) => (row.costUsd == null ? -1 : row.costUsd),
          },
        ],
        r.sessions.map((s) => ({ ...s, model: s.models[0] && s.models[0].model })),
        { sortKey: "totalTokens", sortDir: "desc", limit: 15 },
      ),
    );
  }

  function windowsCard(q) {
    if (q.status === "not-found")
      return ui.card(
        { title: "Quota windows" },
        el("div", { className: "muted" }, "No quota history recorded on this machine yet."),
      );
    if (q.status === "unavailable")
      return ui.card(
        { title: "Quota windows" },
        ui.notice("warning", "Quota history unavailable: " + (q.reason || "read failed")),
      );
    return ui.card(
      { title: "Quota windows", subtitle: "Local usage placed on each observed provider window" },
      charts.table(
        [
          {
            key: "provider",
            label: "Provider",
            format: (v, w) => v + (w.model ? " " + w.model : ""),
          },
          {
            key: "window",
            label: "Window",
            format: (v, w) =>
              v + (w.concurrent ? " ?" : "") + (w.startMethod === "first-observation" ? " +" : ""),
          },
          { key: "startMs", label: "Start (UTC)", format: utcMinute },
          { key: "endMs", label: "End (UTC)", format: utcMinute },
          {
            key: "percentUsed",
            label: "Used",
            numeric: true,
            format: (v) => (v == null ? NA : Math.round(v) + "%"),
          },
          { key: "responses", label: "Resp.", numeric: true, format: fmt.integer },
          { key: "totalTokens", label: "Tokens", numeric: true, format: fmt.compact },
        ],
        q.windows || [],
        { sortKey: "startMs", sortDir: "desc", limit: 12 },
      ),
      el(
        "div",
        { className: "card-note" },
        "? windows from more than one account overlap, so no usage is placed in them; + started at the first observation.",
      ),
      q.unattributed && q.unattributed.length
        ? el(
            "div",
            {},
            el("div", { className: "subhead" }, "Not placed on a window"),
            el(
              "ul",
              { className: "plain-list" },
              q.unattributed.map((u) =>
                el(
                  "li",
                  {},
                  (u.provider || "unknown") +
                    (u.window ? " " + u.window : "") +
                    ": " +
                    fmt.integer(u.responses) +
                    " responses, " +
                    fmt.compact(u.totalTokens) +
                    " tokens (" +
                    u.reason +
                    ")",
                ),
              ),
            ),
          )
        : null,
    );
  }

  function importsCard(imp) {
    const title = "Session Knowledge imports";
    if (imp.status === "not-found")
      return ui.card(
        { title },
        el("div", { className: "muted" }, "None yet. Run `token-watcher sessions import <file>`."),
      );
    if (imp.status === "unavailable")
      return ui.card(
        { title },
        ui.notice("warning", "Import store unavailable: " + (imp.reason || "read failed")),
      );
    const o = imp.outcomes;
    return ui.card(
      { title, subtitle: imp.inRange + " in range of " + imp.storedRecords + " stored" },
      charts.table(
        [
          { key: "source", label: "Source" },
          { key: "owner", label: "Tokens from" },
          { key: "sessions", label: "Sessions", numeric: true, format: fmt.integer },
          { key: "userTurns", label: "User", numeric: true, format: countOrNa },
          { key: "assistantTurns", label: "Assistant", numeric: true, format: countOrNa },
          { key: "toolCalls", label: "Tools", numeric: true, format: countOrNa },
          {
            key: "importedTokens",
            label: "Tokens",
            numeric: true,
            format: (v, row) =>
              v == null ? (row.owner === "native" ? "native" : NA) : fmt.compact(v),
          },
          { key: "withOutcome", label: "Outcome", numeric: true, format: fmt.integer },
        ],
        imp.bySource || [],
        {},
      ),
      el("div", { className: "subhead" }, "Outcomes (git proxy)"),
      o.sessions === 0
        ? el(
            "div",
            { className: "muted" },
            "No imported session in range has a linked commit or pull request.",
          )
        : ui.kpiRow([
            { label: "Linked sessions", value: fmt.integer(o.sessions) },
            {
              label: "Commits",
              value: fmt.integer(o.commits),
              sub: fmt.integer(o.pullRequests) + " pull requests",
            },
            {
              label: "Matched here",
              value: fmt.integer(o.matchedNativeSessions),
              sub: fmt.compact(o.matchedTokens) + " tokens · " + usdOrNa(o.matchedCostUsd),
            },
            { label: "Cost / commit", value: usdOrNa(o.costPerCommitUsd) },
          ]),
      el(
        "div",
        { className: "card-note" },
        "Commits and pull requests Session Knowledge linked to a session; not proof of delivered work.",
      ),
    );
  }

  function render(ctx, page) {
    const SS = ctx.S.sessions;
    page.appendChild(controls(ctx));
    if (SS.error) {
      page.appendChild(ui.notice("warning", SS.error));
      return;
    }
    const r = SS.view;
    if (!r) {
      page.appendChild(ui.loading("Loading sessions…"));
      return;
    }
    page.appendChild(coverageCard(r));
    if (!r.sessions.length)
      page.appendChild(ui.empty("◇", "No sessions with reported usage in this window.", null));
    else {
      page.appendChild(kpis(r));
      page.appendChild(el("div", { className: "grid grid-2" }, weeklyCard(r), lengthCard(r)));
      const scatter = scatterCard(r);
      page.appendChild(el("div", { className: "grid grid-2" }, scatter, topSessionsCard(r)));
    }
    if (r.quotaWindows) page.appendChild(windowsCard(r.quotaWindows));
    if (r.imports) page.appendChild(importsCard(r.imports));
    page.appendChild(
      ui.card(
        { title: "Notes", className: "notes-card" },
        el(
          "ul",
          { className: "plain-list muted" },
          (r.notes || []).map((n) => el("li", {}, n)),
          el("li", {}, NA + " means the value is not available, not zero."),
        ),
      ),
    );
  }

  TW.views.sessions = {
    label: "Sessions",
    icon: "◇",
    title: "Sessions",
    enter(ctx) {
      if (!ctx.S.sessions.view && !ctx.S.sessions.loading) ctx.load.sessions();
    },
    refresh(ctx) {
      return ctx.load.sessions();
    },
    render,
  };
})();
