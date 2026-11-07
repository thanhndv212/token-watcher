/**
 * Alerts — budget rules as gauges: how close each rule is to its threshold
 * for the window it measures, with on/off switches and plain-language rules.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt, charts } = TW;
  const ui = TW.ui;
  TW.views = TW.views || {};

  function statusOf(alert, evaluation) {
    if (!alert.enabled) return { kind: "neutral", label: "Off" };
    if (!evaluation) return { kind: "neutral", label: "Not evaluated" };
    if (evaluation.status === "unknown") return { kind: "info", label: "Unknown" };
    if (evaluation.triggered) return { kind: "critical", label: "Triggered" };
    if ((evaluation.percentUsed || 0) >= 75)
      return { kind: "warning", label: "Within threshold · close" };
    return { kind: "ok", label: "Within threshold" };
  }

  function rangeText(w) {
    if (!w) return null;
    return (
      (w.sinceMs ? fmt.dateTime(w.sinceMs) : "All available history") +
      " – " +
      fmt.dateTime(w.untilMs)
    );
  }

  function ruleCard(ctx, alert, evaluation) {
    const status = statusOf(alert, evaluation);
    const showGauge = alert.enabled && evaluation && evaluation.status !== "unknown";
    const pct = showGauge ? evaluation.percentUsed || 0 : 0;
    return ui.card(
      {
        title: alert.name,
        subtitle: ctx.describeRule(alert),
        className:
          "alert-card" +
          (status.kind === "critical"
            ? " sev-border-critical"
            : status.kind === "warning"
              ? " sev-border-warning"
              : ""),
        actions: [
          ui.pill(status.kind, status.label),
          ui.toggleSwitch(
            alert.enabled,
            async (enabled) => {
              try {
                await ctx.api.alerts.update(alert.id, { enabled });
                await ctx.load.alerts();
              } catch (e) {
                TW.toast(e.message, "error");
                ctx.renderView();
              }
            },
            alert.enabled ? "Disable alert" : "Enable alert",
          ),
        ],
      },
      showGauge
        ? el(
            "div",
            { className: "gauge" },
            el(
              "div",
              { className: "gauge-head" },
              el(
                "span",
                { className: "gauge-value" },
                ctx.formatMetricValue(alert.metric, evaluation.currentValue),
              ),
              el(
                "span",
                { className: "muted" },
                " of " + ctx.formatMetricValue(alert.metric, alert.threshold),
              ),
              el("span", { className: "gauge-pct" }, Math.round(pct) + "%"),
            ),
            charts.meter(Math.min(100, pct), { label: alert.name + " progress toward threshold" }),
          )
        : null,
      alert.enabled && evaluation
        ? el(
            "div",
            { className: "alert-facts" },
            ui.kv("Evaluation", evaluation.message),
            ui.kv("Evaluated", fmt.dateTime(evaluation.evaluatedAt)),
            evaluation.window ? ui.kv("Range", rangeText(evaluation.window)) : null,
          )
        : null,
      el(
        "div",
        { className: "card-foot" },
        ui.button(
          "Delete",
          async () => {
            if (!window.confirm("Delete the alert “" + alert.name + "”?")) return;
            try {
              await ctx.api.alerts.delete(alert.id);
              TW.toast("Alert deleted", "success");
              await ctx.load.alerts();
            } catch (e) {
              TW.toast(e.message, "error");
            }
          },
          { kind: "danger", small: true },
        ),
      ),
    );
  }

  function render(ctx, page) {
    const S = ctx.S;
    const budget = S.budget;
    if (budget && budget.diagnostic) page.appendChild(ui.notice("warning", budget.diagnostic));
    const results = (budget && budget.results) || [];
    const evalFor = (alert) => results.find((r) => r.rule.id === alert.id);
    const counts = { triggered: 0, close: 0, ok: 0, off: 0 };
    for (const a of S.alerts) {
      const s = statusOf(a, evalFor(a));
      if (s.kind === "critical") counts.triggered++;
      else if (s.kind === "warning") counts.close++;
      else if (s.kind === "ok") counts.ok++;
      else counts.off++;
    }
    page.appendChild(
      el(
        "div",
        { className: "toolbar" },
        el(
          "span",
          { className: "muted" },
          S.alerts.length + " rule" + (S.alerts.length !== 1 ? "s" : ""),
        ),
        counts.triggered ? ui.pill("critical", counts.triggered + " triggered") : null,
        counts.close ? ui.pill("warning", counts.close + " above 75%") : null,
        counts.ok ? ui.pill("ok", counts.ok + " within threshold") : null,
        el("span", { className: "toolbar-spacer" }),
        ui.button("+ New alert", () => ctx.modals.createAlert(), { kind: "primary", small: true }),
      ),
    );
    if (!S.alerts.length) {
      page.appendChild(
        ui.empty(
          "⚑",
          "No budget alerts configured",
          "Create alerts to monitor your token spending",
          ui.button("+ New alert", () => ctx.modals.createAlert(), { kind: "primary" }),
        ),
      );
      return;
    }
    // Triggered and closest-to-threshold rules first.
    const order = (a) => {
      const e = evalFor(a);
      if (!a.enabled) return -2;
      if (!e || e.status === "unknown") return -1;
      return (e.triggered ? 1000 : 0) + (e.percentUsed || 0);
    };
    const sorted = S.alerts.slice().sort((a, b) => order(b) - order(a));
    page.appendChild(
      el(
        "div",
        { className: "grid grid-cards" },
        sorted.map((a) => ruleCard(ctx, a, evalFor(a))),
      ),
    );
  }

  TW.views.alerts = {
    label: "Alerts",
    icon: "⚑",
    title: "Budget alerts",
    enter(ctx) {
      ctx.load.alerts();
    },
    refresh(ctx) {
      return ctx.load.alerts();
    },
    render,
  };
})();
