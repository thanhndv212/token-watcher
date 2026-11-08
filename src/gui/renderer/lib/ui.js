/**
 * Token Watcher renderer — UI kit (cards, KPI tiles, chips, modals, forms).
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt } = TW;

  function card(opts, ...children) {
    const o = opts || {};
    const header =
      o.title || o.actions
        ? el(
            "div",
            { className: "card-head" },
            el(
              "div",
              { className: "card-head-text" },
              o.title ? el("h3", { className: "card-title" }, o.title) : null,
              o.subtitle ? el("div", { className: "card-sub" }, o.subtitle) : null,
            ),
            o.actions ? el("div", { className: "card-actions" }, o.actions) : null,
          )
        : null;
    return el(
      "section",
      {
        className: "card " + (o.className || ""),
        style: o.span ? { gridColumn: "span " + o.span } : null,
      },
      header,
      ...children,
    );
  }

  /** Segmented control; options: [{ value, label, title? }]. */
  function segmented(options, current, onChange, opts) {
    return el(
      "div",
      {
        className: "seg" + (opts && opts.small ? " small" : ""),
        role: "group",
        "aria-label": opts && opts.label,
      },
      options.map((o) =>
        el(
          "button",
          {
            className: "seg-btn" + (o.value === current ? " active" : ""),
            "aria-pressed": o.value === current ? "true" : "false",
            title: o.title,
            onClick: () => {
              if (o.value !== current) onChange(o.value);
            },
          },
          o.label,
        ),
      ),
    );
  }

  /**
   * Chart card with a Chart/Table toggle — the table view is the accessible
   * fallback for every chart and the relief for low-contrast series colors.
   */
  function chartCard(opts) {
    let mode = "chart";
    const body = el("div", { className: "chart-body" });
    const paint = () => {
      TW.clear(body);
      TW.hideTooltip();
      body.appendChild(mode === "chart" ? opts.chart() : opts.table());
    };
    const toggleHost = el("div", {});
    const build = () =>
      segmented(
        [
          { value: "chart", label: "Chart" },
          { value: "table", label: "Table" },
        ],
        mode,
        (v) => {
          mode = v;
          TW.clear(toggleHost);
          toggleHost.appendChild(build());
          paint();
        },
        { small: true, label: "View as" },
      );
    if (opts.table) toggleHost.appendChild(build());
    paint();
    return card(
      {
        title: opts.title,
        subtitle: opts.subtitle,
        className: "chart-card " + (opts.className || ""),
        span: opts.span,
        actions: [opts.actions || null, opts.table ? toggleHost : null],
      },
      opts.legend && opts.legend.length > 1 ? TW.charts.legend(opts.legend) : null,
      body,
      opts.note ? el("div", { className: "card-note" }, opts.note) : null,
    );
  }

  /** Delta vs the previous period, in ink (spend going up is not inherently "bad"). */
  function deltaBadge(share, suffix) {
    if (share == null || !Number.isFinite(share)) return null;
    const dir = Math.round(share * 100) === 0 ? "flat" : share > 0 ? "up" : "down";
    return el(
      "span",
      { className: "delta delta-" + dir, title: "Change vs the previous period of equal length" },
      el(
        "span",
        { className: "delta-arrow", "aria-hidden": "true" },
        dir === "up" ? "▲" : dir === "down" ? "▼" : "■",
      ),
      fmt.signedPct(share),
      suffix ? el("span", { className: "delta-suffix" }, " " + suffix) : null,
    );
  }

  /** KPI tile: label, one figure, optional delta + sparkline. */
  function kpi(o) {
    return el(
      "div",
      { className: "kpi", title: o.title || null },
      el("div", { className: "kpi-label" }, o.label),
      el("div", { className: "kpi-value" }, o.value),
      el(
        "div",
        { className: "kpi-foot" },
        o.delta != null
          ? deltaBadge(o.delta)
          : o.sub
            ? el("span", { className: "kpi-sub" }, o.sub)
            : el("span", { className: "kpi-sub" }, " "),
        o.spark && o.spark.length ? TW.charts.sparkline(o.spark, { width: 64, height: 20 }) : null,
      ),
      o.delta != null && o.sub ? el("div", { className: "kpi-sub" }, o.sub) : null,
    );
  }

  function kpiRow(items) {
    return el("div", { className: "kpi-row" }, items.map(kpi));
  }

  function empty(icon, text, hint, action) {
    return el(
      "div",
      { className: "empty-state" },
      icon ? el("div", { className: "empty-icon", "aria-hidden": "true" }, icon) : null,
      el("div", { className: "empty-text" }, text),
      hint ? el("div", { className: "empty-hint" }, hint) : null,
      action || null,
    );
  }

  function loading(text) {
    return el(
      "div",
      { className: "loading" },
      el("span", { className: "spinner" }),
      text || "Loading…",
    );
  }

  function kv(key, value, opts) {
    return el(
      "div",
      { className: "kv" + (opts && opts.strong ? " strong" : "") },
      el("span", { className: "kv-key" }, key),
      el("span", { className: "kv-value" }, value),
    );
  }

  /** Status pill: kinds ok | warning | serious | critical | neutral | info. Icon + label, never color alone. */
  function pill(kind, label, icon) {
    const glyph =
      icon ?? { ok: "✓", warning: "●", serious: "◆", critical: "▲", info: "i", neutral: "" }[kind];
    return el(
      "span",
      { className: "pill pill-" + kind },
      glyph ? el("span", { className: "pill-icon", "aria-hidden": "true" }, glyph) : null,
      label,
    );
  }

  function notice(kind, text, action) {
    return el(
      "div",
      { className: "notice notice-" + kind, role: kind === "critical" ? "alert" : null },
      el(
        "span",
        { className: "notice-icon", "aria-hidden": "true" },
        kind === "critical" ? "▲" : kind === "warning" ? "●" : "i",
      ),
      el("span", { className: "notice-text" }, text),
      action || null,
    );
  }

  function button(label, onClick, opts) {
    const o = opts || {};
    return el(
      "button",
      {
        className:
          "btn " +
          (o.kind ? "btn-" + o.kind : "") +
          (o.small ? " btn-small" : "") +
          (o.className ? " " + o.className : ""),
        onClick,
        title: o.title,
        disabled: o.disabled,
      },
      label,
    );
  }

  function sectionTitle(text, sub) {
    return el(
      "div",
      { className: "section-title" },
      el("h2", {}, text),
      sub ? el("span", { className: "section-sub" }, sub) : null,
    );
  }

  // ── Modal ──────────────────────────────────────────────────────────────
  function openModal(title, buildBody) {
    const overlay = el("div", { className: "modal-overlay" });
    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    const modal = el("div", {
      className: "modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title,
    });
    modal.appendChild(el("div", { className: "modal-title" }, title));
    const { body, actions } = buildBody(close);
    modal.appendChild(el("div", { className: "modal-body" }, body));
    if (actions) modal.appendChild(el("div", { className: "modal-actions" }, actions));
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const first = modal.querySelector("input, select, textarea");
    if (first) first.focus();
    return close;
  }

  function field(label, control, hint) {
    return el(
      "label",
      { className: "field" },
      el("span", { className: "field-label" }, label),
      control,
      hint ? el("span", { className: "field-hint" }, hint) : null,
    );
  }

  function input(attrs) {
    return el("input", { className: "input", ...attrs });
  }

  /** options: [[value, label]] or [value] */
  function select(options, value, onChange, attrs) {
    const s = el("select", {
      className: "select",
      ...(attrs || {}),
      onChange: (e) => onChange(e.target.value),
    });
    for (const o of options) {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      const opt = el("option", { value: v }, l);
      if (String(v) === String(value)) opt.selected = true;
      s.appendChild(opt);
    }
    return s;
  }

  function toggleSwitch(checked, onChange, label) {
    const inputNode = el("input", {
      type: "checkbox",
      className: "switch-input",
      "aria-label": label,
    });
    inputNode.checked = !!checked;
    inputNode.addEventListener("change", () => onChange(inputNode.checked));
    return el(
      "label",
      { className: "switch", title: label },
      inputNode,
      el("span", { className: "switch-track" }, el("span", { className: "switch-thumb" })),
    );
  }

  // Views re-render on every quota update and history load, which replaces each
  // <details> node. Remember which ones the user opened so a background refresh
  // never collapses what they are reading.
  const openDisclosures = new Set();
  function disclosure(key, attrs, ...children) {
    return el(
      "details",
      {
        ...attrs,
        open: openDisclosures.has(key),
        onToggle: (event) => {
          if (event.currentTarget.open) openDisclosures.add(key);
          else openDisclosures.delete(key);
        },
      },
      ...children,
    );
  }

  TW.ui = {
    card,
    disclosure,
    segmented,
    chartCard,
    deltaBadge,
    kpi,
    kpiRow,
    empty,
    loading,
    kv,
    pill,
    notice,
    button,
    sectionTitle,
    openModal,
    field,
    input,
    select,
    toggleSwitch,
  };
})();
