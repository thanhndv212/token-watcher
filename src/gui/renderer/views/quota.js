/**
 * Quota — every provider window now, and how it moved over time.
 *
 * Forecasting rule (INS03): no pace or exhaustion forecast is derived from a
 * window label here. Only the shared `runway` string from accountingDetails is
 * shown (a linear average since the fixed-window start), and history is shown
 * descriptively: observed values, peaks, and changes between observations.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt, charts } = TW;
  const ui = TW.ui;
  TW.views = TW.views || {};

  // ── Current quota ──────────────────────────────────────────────────────
  function windowRow(ctx, w, showTag) {
    const used = ctx.quota.usedOf(w);
    const sev = TW.severity(used);
    return el(
      "div",
      { className: "qrow" },
      showTag
        ? el(
            "span",
            { className: "qrow-tag", title: ctx.quota.windowTag(w) },
            ctx.quota.windowTag(w),
          )
        : null,
      charts.meter(used, { label: (w.group || w.name) + " " + ctx.quota.windowTag(w) }),
      el(
        "span",
        { className: "qrow-pct" },
        sev.key !== "ok"
          ? el(
              "span",
              { className: "sev-icon sev-" + sev.key, "aria-label": sev.label },
              sev.icon + " ",
            )
          : null,
        Math.round(used) + "%",
      ),
      ctx.quota.countdown(w.resetTimeIso),
    );
  }

  function quotaCard(ctx, g) {
    const pctWindows = g.windows.filter((w) => w.kind !== "value" && w.percentRemaining != null);
    const worst = pctWindows.length ? Math.max(...pctWindows.map(ctx.quota.usedOf)) : null;
    const sev = worst == null ? null : TW.severity(worst);
    const account = (g.windows.find((w) => w.account) || {}).account;
    const value = g.windows.find((w) => w.kind === "value");
    return ui.card(
      {
        title: g.name,
        subtitle: account ? el("span", { className: "account", title: account }, account) : null,
        actions: sev && sev.key !== "ok" ? ui.pill(sev.key, sev.label) : null,
        className: "quota-card" + (sev ? " sev-border-" + sev.key : ""),
      },
      value
        ? el(
            "div",
            { className: "quota-value" },
            el(
              "span",
              {
                className:
                  "quota-value-figure" + (String(value.value).length > 18 ? " is-text" : ""),
              },
              value.value,
            ),
            ctx.quota.countdown(value.resetTimeIso),
          )
        : null,
      pctWindows.length
        ? el(
            "div",
            { className: "qrows" },
            pctWindows.map((w) => windowRow(ctx, w, !g.single)),
          )
        : null,
      pctWindows.length && g.single
        ? el("div", { className: "card-note" }, Math.round(100 - worst) + "% left")
        : null,
    );
  }

  function accountingDetails(rows) {
    return ui.disclosure(
      "quota-accounting-details",
      { className: "card accounting-details" },
      el("summary", { className: "card-title" }, "Balances and usage details"),
      rows.map((row) =>
        el(
          "div",
          { className: "accounting-detail-row" },
          el(
            "div",
            { className: "card-sub" },
            row.providerId +
              " · " +
              row.name +
              (row.prominence === "supplementary" ? " · Additional detail" : ""),
          ),
          el("div", { className: "accounting-detail-value" }, row.value),
          (row.facts || []).map((f) => ui.kv(f.label, f.value)),
        ),
      ),
    );
  }

  function renderCurrent(ctx, page) {
    const S = ctx.S;
    const q = S.quota;
    if (!q) {
      page.appendChild(
        ui.empty("◔", "No quota data loaded", "Click Refresh to fetch quota status"),
      );
      return;
    }
    for (const message of q.historyDiagnostics || []) page.appendChild(ui.notice("info", message));
    for (const err of q.errors || [])
      page.appendChild(ui.notice("warning", (err.label ? err.label + ": " : "") + err.message));

    const providerIds = q.detectedProviderIds || [];
    if (S.quotaFilter !== "all" && !providerIds.includes(S.quotaFilter)) S.quotaFilter = "all";
    if (providerIds.length > 1)
      page.appendChild(
        el(
          "div",
          { className: "toolbar" },
          ui.segmented(
            [
              { value: "all", label: "All (" + providerIds.length + ")" },
              ...providerIds.map((id) => ({ value: id, label: id })),
            ],
            S.quotaFilter,
            (v) => {
              S.quotaFilter = v;
              ctx.renderView();
            },
            { label: "Provider", small: true },
          ),
        ),
      );

    const filtered = ctx.quota.filterEntries(q.entries || [], S.quotaFilter);
    const groups = ctx.quota.groupEntries(filtered);
    if (!groups.length)
      page.appendChild(ui.empty(null, "No quota entries for this provider", null));
    else
      page.appendChild(
        el(
          "div",
          { className: "grid grid-cards" },
          groups.map((g) => quotaCard(ctx, g)),
        ),
      );

    const details = (q.accountingDetails || []).filter(
      (row) => S.quotaFilter === "all" || row.providerId === S.quotaFilter,
    );
    const estimates = details.filter((row) => row.runway);
    if (estimates.length)
      page.appendChild(
        ui.card(
          { title: "Fixed-window estimates", className: "runway-estimates" },
          el(
            "div",
            { className: "runway-list" },
            estimates.map((row) => {
              const reset = (row.facts || []).find((f) => f.label === "Reset");
              return el(
                "div",
                { className: "runway-row" },
                el("div", { className: "runway-name" }, row.name),
                el("div", { className: "runway-value" }, row.runway),
                reset ? el("div", { className: "muted" }, "Reset: " + reset.value) : null,
              );
            }),
          ),
          el(
            "div",
            { className: "card-note" },
            "Linear average since fixed-window start; not a recent-rate prediction.",
          ),
        ),
      );
    if (details.length) page.appendChild(accountingDetails(details));

    if (q.sessionTokens)
      page.appendChild(
        ui.card(
          { title: "Session tokens" },
          ui.kpiRow([
            { label: "Input", value: fmt.compact(q.sessionTokens.totalInput) },
            { label: "Output", value: fmt.compact(q.sessionTokens.totalOutput) },
          ]),
        ),
      );
  }

  // ── History ────────────────────────────────────────────────────────────
  const accountLabel = (id) =>
    !id || id === "unknown" ? "Unknown account" : "Account " + id.slice(0, 8);

  /** account → kind → points, from the collapsed snapshot series. */
  function seriesByAccount(snapshots) {
    const byAccount = new Map();
    for (const snap of snapshots || []) {
      const acc =
        snap.accountIdentity && snap.accountIdentity !== "unknown"
          ? snap.accountIdentity
          : "unknown";
      if (!byAccount.has(acc)) byAccount.set(acc, new Map());
      const kinds = byAccount.get(acc);
      for (const limit of snap.limits || []) {
        const kind = String(limit.kind || limit.group || "quota").replace(/:+$/, "");
        if (!kinds.has(kind)) kinds.set(kind, []);
        kinds.get(kind).push({ t: snap.timestamp, v: limit.percent, resetsAt: limit.resets_at });
      }
    }
    for (const kinds of byAccount.values())
      for (const pts of kinds.values()) pts.sort((a, b) => a.t - b.t);
    return byAccount;
  }

  /** Descriptive only: latest, peak, change since the previous observation. */
  function describe(points) {
    const latest = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2] : null;
    const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
    const stepUp = prev && latest.v >= prev.v ? latest.v - prev.v : null;
    return {
      latest,
      prev,
      peak,
      stepUp,
      resets: points.filter((p, i) => i > 0 && p.v < points[i - 1].v - 5).length,
    };
  }

  function historyChart(ctx, account, kinds, markers) {
    const H = ctx.S.history;
    const names = [...kinds.keys()].sort((a, b) => a.localeCompare(b));
    const series = names.map((k, i) => ({
      key: k,
      label: k,
      color: "var(--s" + ((i % 5) + 1) + ")",
      kind: "line",
      points: kinds.get(k),
    }));
    const now = Date.now();
    const domain = [now - H.days * ctx.DAY_MS, now];
    const stats = el(
      "div",
      { className: "hist-stats" },
      series.map((s) => {
        const d = describe(s.points);
        return el(
          "div",
          { className: "hist-stat" },
          el("span", { className: "swatch line", style: { background: s.color } }),
          el("span", { className: "hist-stat-name" }, s.label),
          el("span", { className: "hist-stat-value" }, Math.round(d.latest.v) + "% used"),
          el(
            "span",
            { className: "muted" },
            "peak " +
              Math.round(d.peak.v) +
              "%" +
              (d.stepUp && d.stepUp >= 0.05 && d.prev
                ? " · +" + d.stepUp.toFixed(1) + " pts over " + fmt.duration(d.latest.t - d.prev.t)
                : "") +
              (d.resets ? " · " + d.resets + " drop" + (d.resets > 1 ? "s" : "") : ""),
          ),
        );
      }),
    );
    return ui.chartCard({
      title: "Usage over time · " + accountLabel(account),
      subtitle: "Percent of each window used, as observed · last " + H.days + " days",
      legend: series,
      chart: () =>
        el(
          "div",
          {},
          charts.line({
            series,
            xDomain: domain,
            yMax: 100,
            yFormat: (v) => Math.round(v) + "%",
            height: 170,
            markers,
            // Observations are captured on refresh; a 3h silence is a gap, not a trend.
            gapMs: 3 * 3_600_000,
          }),
          stats,
        ),
      table: () =>
        charts.table(
          [
            { key: "t", label: "Observed", format: (v) => fmt.dateTime(v) },
            { key: "kind", label: "Window" },
            { key: "v", label: "Used", numeric: true, format: (v) => Math.round(v) + "%" },
          ],
          series.flatMap((s) => s.points.map((p) => ({ t: p.t, kind: s.label, v: p.v }))),
          { sortKey: "t", sortDir: "desc", limit: 12 },
        ),
      note: markers.length ? "Dashed lines mark confirmed resets." : null,
    });
  }

  function eventsCard(ctx, events) {
    const H = ctx.S.history;
    const stateKind = {
      delivered: "ok",
      uncertain: "warning",
      pending: "neutral",
      failed: "critical",
    };
    return ui.card(
      { title: "Confirmed Reset Events", subtitle: H.status || null },
      !events.length
        ? el("div", { className: "muted" }, "No confirmed resets recorded.")
        : el(
            "div",
            { className: "event-list" },
            events.slice(0, 20).map((event) =>
              el(
                "div",
                { className: "event-row" },
                ui.pill(stateKind[event.state] || "neutral", event.state),
                el("span", { className: "event-window" }, event.windowId),
                el("span", { className: "muted" }, accountLabel(event.accountIdentity)),
                el("span", { className: "event-time" }, fmt.dateTime(event.observedAt)),
                event.state === "uncertain"
                  ? ui.button(
                      "Retry uncertain notice",
                      async () => {
                        if (
                          !window.confirm(
                            "A notice may already have appeared. Retry this reset notification?",
                          )
                        )
                          return;
                        try {
                          await ctx.api.resets.retry(event.id);
                          await ctx.load.history();
                        } catch {
                          TW.toast("Reset retry unavailable", "error");
                        }
                      },
                      { small: true },
                    )
                  : null,
              ),
            ),
          ),
    );
  }

  function burningCard(ctx) {
    const sessions = (ctx.S.history.burning || []).filter(
      (s) => s.tokens && (s.tokens.input || s.tokens.output),
    );
    const weight = (s) =>
      (s.tokens.input || 0) +
      (s.tokens.output || 0) +
      (s.tokens.cache_write || 0) +
      (s.tokens.cache_read || 0) * 0.1;
    const ranked = sessions
      .map((s) => ({ ...s, weight: weight(s) }))
      .sort((a, b) => b.weight - a.weight);
    const total = ranked.reduce((a, s) => a + s.weight, 0);
    return ui.card(
      {
        title: "What's Burning Your Quota",
        subtitle:
          "Sessions by weighted tokens in the last 5 hours (cache reads count ×0.1) · this machine only, approximate",
      },
      ranked.length
        ? charts.rankedBars(
            ranked.slice(0, 5).map((s) => ({
              key: s.sessionID,
              label: s.title || "Session " + String(s.sessionID || "").slice(0, 8),
              value: s.weight,
              sub: fmt.integer(s.messageCount || 0) + " msgs · " + fmt.usd(s.costUsd || 0),
              color: "var(--s2)",
            })),
            { total, format: (v) => fmt.compact(v) + " wt" },
          )
        : el("div", { className: "muted" }, "No active sessions in this window."),
    );
  }

  function modelBreakdownCard(ctx) {
    const H = ctx.S.history;
    const rows = H.sourceModels || [];
    const sources = [...new Set(rows.map((r) => TW.providerLabel(r.sourceProviderID)))].sort();
    if (H.sourceFilter !== "all" && !sources.includes(H.sourceFilter)) H.sourceFilter = "all";
    const filtered = rows
      .filter(
        (r) => H.sourceFilter === "all" || TW.providerLabel(r.sourceProviderID) === H.sourceFilter,
      )
      .map((r) => ({
        key: r.sourceProviderID + "/" + r.sourceModelID,
        label:
          (H.sourceFilter === "all" ? TW.providerLabel(r.sourceProviderID) + " / " : "") +
          r.sourceModelID,
        value: r.costUsd || 0,
      }))
      .sort((a, b) => b.value - a.value);
    const top = filtered.slice(0, 8);
    const rest = filtered.slice(8).reduce((a, r) => a + r.value, 0);
    if (rest > 0)
      top.push({
        key: "other",
        label: "Other " + (filtered.length - 8) + " models",
        value: rest,
        muted: true,
        color: "var(--muted)",
      });
    return ui.card(
      {
        title: "Model Cost Breakdown",
        subtitle: "Estimated cost by model · last " + H.days + " days",
        actions:
          sources.length > 1
            ? ui.select(
                [["all", "All sources"], ...sources.map((s) => [s, s])],
                H.sourceFilter,
                (v) => {
                  H.sourceFilter = v;
                  ctx.renderView();
                },
              )
            : null,
      },
      top.length
        ? charts.rankedBars(top, { format: (v) => fmt.usd(v) })
        : el("div", { className: "muted" }, "No usage recorded for this range."),
    );
  }

  function legacyResetsCard(ctx) {
    const H = ctx.S.history;
    const resets = H.account === "all" || H.account === "unknown" ? H.resets || [] : [];
    const capped = resets.filter((r) => (r.quota_used || 0) >= 99).length;
    return ui.card(
      {
        title: "Legacy Reset History (account unknown)",
        subtitle: resets.length
          ? capped + " of " + resets.length + " window(s) fully capped (≥99% used)"
          : null,
      },
      resets.length
        ? charts.rankedBars(
            resets.slice(0, 6).map((r) => ({
              key: r.reset_at + r.reset_type,
              label: new Date(r.reset_at).toLocaleDateString() + " · " + r.reset_type,
              value: Math.round(r.quota_used || 0),
              valueText: Math.round(r.quota_used || 0) + "% used",
              sub:
                Math.round(r.quota_remaining ?? 100 - (r.quota_used || 0)) +
                "% left unused at reset",
              color: (r.quota_used || 0) >= 99 ? "var(--critical)" : "var(--s1)",
            })),
            { total: 0 },
          )
        : el("div", { className: "muted" }, "No resets recorded yet."),
    );
  }

  function renderHistory(ctx, page) {
    const H = ctx.S.history;
    const section = el("div", { id: "quota-history", className: "history" });
    section.appendChild(ui.sectionTitle("Quota History", H.loading ? "Loading…" : null));
    page.appendChild(section);
    if (H.error) section.appendChild(ui.notice("warning", H.error));
    if (!H.providersLoaded) {
      section.appendChild(ui.loading("Loading history…"));
      return;
    }
    if (!H.providers.length) {
      section.appendChild(
        ui.empty(
          "◷",
          "No quota history yet",
          "Snapshots are captured automatically whenever quota is checked.",
        ),
      );
      return;
    }

    const accounts = [
      ...new Set([
        ...H.quota.map((r) => r.accountIdentity || "unknown"),
        ...H.accounting.map((r) => r.detail.accountIdentity),
      ]),
    ];
    const providerOptions = [...new Set([...H.providers, H.provider].filter(Boolean))];
    section.appendChild(
      el(
        "div",
        { className: "toolbar" },
        ui.select(
          providerOptions.map((p) => [p, TW.providerLabel(p)]),
          H.provider,
          (v) => {
            H.provider = v;
            H.account = "all";
            H.window = null;
            ctx.load.history();
          },
          { "aria-label": "Provider" },
        ),
        ui.select(
          [
            ["all", "All accounts (separate series)"],
            ...accounts.map((id) => [id, accountLabel(id)]),
          ],
          H.account,
          (v) => {
            H.account = v;
            ctx.renderView();
          },
          { className: "select history-account-filter", "aria-label": "Account" },
        ),
        ui.segmented(
          [
            { value: 7, label: "7 days" },
            { value: 30, label: "30 days" },
          ],
          H.days,
          (v) => {
            H.days = v;
            ctx.load.history();
          },
          { small: true, label: "Range" },
        ),
      ),
    );
    section.appendChild(
      el(
        "div",
        { className: "card-note" },
        "Unknown observations are kept separate from identified accounts. An account label identifies only observations from the same selected account.",
      ),
    );
    if (H.window)
      section.appendChild(
        el(
          "div",
          { className: "toolbar" },
          el(
            "button",
            {
              className: "chip chip-active",
              onClick: () => {
                H.window = null;
                ctx.renderView();
              },
            },
            "Window: " + H.window + " · Show all windows",
          ),
        ),
      );

    const matchAccount = (id) => H.account === "all" || (id || "unknown") === H.account;
    const events = (H.events || []).filter(
      (e) =>
        e.providerId === H.provider &&
        matchAccount(e.accountIdentity) &&
        (!H.window || e.windowId === H.window),
    );
    const selectedHistory = (H.window ? [] : H.quota).filter((item) =>
      matchAccount(item.accountIdentity),
    );
    const grid = el("div", { className: "grid grid-history" });
    const byAccount = seriesByAccount(selectedHistory);
    if (!byAccount.size) {
      grid.appendChild(
        ui.card(
          { title: "Usage over time" },
          el(
            "div",
            { className: "muted" },
            H.window
              ? "Showing reset events for the selected window."
              : "No history yet for this range.",
          ),
        ),
      );
    }
    for (const [account, kinds] of byAccount) {
      const markers = events
        .filter((e) => e.accountIdentity === account)
        .map((e) => ({ t: e.observedAt, label: "Confirmed reset · " + e.windowId }));
      grid.appendChild(historyChart(ctx, account, kinds, markers));
    }
    grid.appendChild(eventsCard(ctx, events));
    section.appendChild(grid);

    const latest = new Map();
    for (const item of H.accounting.filter(
      (i) =>
        matchAccount(i.detail.accountIdentity) && (!H.window || i.detail.windowId === H.window),
    ))
      latest.set(item.detail.key, item.detail);
    if (latest.size) section.appendChild(accountingDetails([...latest.values()]));
    // Snapshot errors are diagnostics, not the story: one collapsed card, newest first.
    const snapErrors = selectedHistory
      .filter((s) => s.error)
      .slice(-5)
      .reverse();
    if (snapErrors.length)
      section.appendChild(
        ui.disclosure(
          "quota-snapshot-errors",
          { className: "card snapshot-errors" },
          el(
            "summary",
            { className: "card-title" },
            snapErrors.length + " recent snapshot error" + (snapErrors.length > 1 ? "s" : ""),
            el(
              "span",
              { className: "muted" },
              " · latest " + fmt.dateTime(snapErrors[0].timestamp),
            ),
          ),
          snapErrors.map((snap) =>
            el(
              "div",
              { className: "snapshot-error" },
              el("div", { className: "muted" }, fmt.dateTime(snap.timestamp)),
              el("div", { className: "snapshot-error-text" }, snap.error),
            ),
          ),
        ),
      );

    section.appendChild(
      el(
        "div",
        { className: "card-note" },
        "Local usage totals are not filtered by quota account.",
      ),
    );
    section.appendChild(
      el("div", { className: "grid grid-2" }, burningCard(ctx), modelBreakdownCard(ctx)),
    );
    section.appendChild(legacyResetsCard(ctx));

    if (H.focus && !H.loading) {
      H.focus = false;
      requestAnimationFrame(() => section.scrollIntoView({ block: "start" }));
    }
  }

  TW.views.quota = {
    label: "Quota",
    icon: "◔",
    title: "Quota",
    enter(ctx, opts) {
      if (opts.focusHistory) {
        ctx.S.history.focus = true;
        ctx.S.history.providersLoaded = false;
      }
      ctx.load.history();
    },
    refresh(ctx) {
      ctx.S.history.providersLoaded = false;
      return ctx.load.history();
    },
    render(ctx, page) {
      renderCurrent(ctx, page);
      renderHistory(ctx, page);
    },
  };
})();
