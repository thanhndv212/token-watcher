/**
 * Token Watcher — desktop renderer shell.
 *
 * Vanilla JS on `window.quotaApi` (contextBridge). This file owns state, data
 * loading, navigation and the shared modals; each tab lives in views/*.js and
 * registers itself on `TW.views`. Everything shown is computed locally from
 * quota fetches and local usage stores; nothing here calls a model.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, clear, fmt, toast } = TW;
  const ui = TW.ui;
  const DAY_MS = 86_400_000;

  const api = window.quotaApi;
  if (!api) {
    document.getElementById("root").innerHTML =
      '<div class="empty-state"><div class="empty-text">quotaApi not available</div><div class="empty-hint">This app must run inside the Electron shell.</div></div>';
    return;
  }

  // ── State ──────────────────────────────────────────────────────────────
  const S = {
    tab: "overview",
    quota: null,
    quotaFilter: "all",
    /** days → { data, at, loading, error } */
    timelines: {},
    usageDays: 30,
    usageMetric: "tokens",
    usageScope: "local",
    /** days → { aggregate, at } (tokens.query over the same range, for top sessions) */
    usageAggregates: {},
    merged: null,
    mergedLoading: false,
    alerts: [],
    budget: null,
    pricing: { overrides: [], snapshot: null, loaded: false, refreshing: false },
    apikeys: null,
    version: null,
    theme: "system",
    history: {
      providers: [],
      providersLoaded: false,
      provider: null,
      account: "all",
      window: null,
      days: 7,
      quota: [],
      accounting: [],
      resets: [],
      events: [],
      status: "",
      sourceModels: [],
      sourceFilter: "all",
      burning: [],
      error: null,
      loading: false,
    },
    sessions: { view: null, error: null, days: 28, windows: false, imports: false, loading: false },
  };

  // ── Rendering ──────────────────────────────────────────────────────────
  const root = document.getElementById("root");
  let contentEl = null;
  let titleEl = null;
  let statusEl = null;

  const TAB_ORDER = ["overview", "quota", "usage", "sessions", "alerts", "settings"];

  function view(key) {
    return TW.views[key];
  }

  function renderShell() {
    clear(root);
    titleEl = el("h1", { className: "app-title" }, view(S.tab).title);
    statusEl = el("span", { className: "app-status", role: "status" });
    const header = el(
      "header",
      { className: "app-header" },
      el(
        "div",
        { className: "brand" },
        el("span", { className: "brand-mark", "aria-hidden": "true" }, "◔"),
        el("span", { className: "brand-name" }, "Token Watcher"),
      ),
      titleEl,
      statusEl,
      el(
        "div",
        { className: "header-actions" },
        el(
          "button",
          {
            className: "btn btn-small btn-refresh",
            onClick: refreshAll,
            title: "Refresh quota and this view",
          },
          "⟳ Refresh",
        ),
        el(
          "button",
          {
            className: "btn-icon",
            onClick: () => api.app.quit(),
            title: "Quit",
            "aria-label": "Quit",
          },
          "✕",
        ),
      ),
    );
    const nav = el(
      "nav",
      { className: "tab-nav", "aria-label": "Sections" },
      TAB_ORDER.map((key) =>
        el(
          "button",
          {
            className: "tab-btn" + (key === S.tab ? " active" : ""),
            dataset: { tab: key },
            "aria-current": key === S.tab ? "page" : null,
            onClick: () => go(key),
          },
          el("span", { className: "tab-icon", "aria-hidden": "true" }, view(key).icon),
          el("span", { className: "tab-label" }, view(key).label),
        ),
      ),
    );
    contentEl = el("main", { className: "content" });
    root.appendChild(
      el("div", { className: "app" }, header, el("div", { className: "app-body" }, nav, contentEl)),
    );
    updateStatus();
    renderView();
  }

  function renderView() {
    if (!contentEl) return;
    const scroll = contentEl.scrollTop;
    TW.hideTooltip();
    clear(contentEl);
    const page = el("div", { className: "page page-" + S.tab });
    try {
      view(S.tab).render(ctx, page);
    } catch (err) {
      console.error(err);
      page.appendChild(
        ui.notice(
          "critical",
          "This view failed to render: " + (err && err.message ? err.message : String(err)),
        ),
      );
    }
    contentEl.appendChild(page);
    contentEl.scrollTop = scroll;
  }

  /** Re-render only when the given tab(s) are on screen. */
  function rerender(...tabs) {
    if (!tabs.length || tabs.includes(S.tab)) renderView();
  }

  function go(key, opts) {
    if (!TW.views[key]) return;
    const changed = key !== S.tab;
    S.tab = key;
    for (const btn of root.querySelectorAll(".tab-btn")) {
      const active = btn.dataset.tab === key;
      btn.classList.toggle("active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
    if (titleEl) titleEl.textContent = view(key).title;
    if (changed && contentEl) contentEl.scrollTop = 0;
    renderView();
    if (view(key).enter) view(key).enter(ctx, opts || {});
  }

  function quotaStatusText() {
    const q = S.quota;
    if (!q) return "Waiting for quota";
    const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (q.fetching) return "Refreshing quota…";
    if (q.previousObservation)
      return (
        "Showing previous observation" +
        (q.lastObservationAt ? " from " + hm(q.lastObservationAt) : "")
      );
    if (q.stale) return "Some quota is unavailable";
    if (q.lastSuccessAt) return "Updated " + hm(q.lastSuccessAt);
    return "Waiting for quota";
  }

  function updateStatus() {
    if (!statusEl) return;
    statusEl.textContent = quotaStatusText();
    statusEl.classList.toggle(
      "is-stale",
      !!(S.quota && (S.quota.stale || S.quota.previousObservation)),
    );
  }

  function setBusy(busy) {
    const btn = root.querySelector(".btn-refresh");
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? "⟳ Refreshing…" : "⟳ Refresh";
  }

  // ── Loaders ────────────────────────────────────────────────────────────
  async function refreshQuota() {
    try {
      receiveQuota(await api.quota.fetch(true));
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function refreshAll() {
    setBusy(true);
    const tasks = [refreshQuota()];
    const v = view(S.tab);
    if (v.refresh) tasks.push(v.refresh(ctx));
    await Promise.allSettled(tasks);
    setBusy(false);
    renderView();
  }

  function receiveQuota(snapshot) {
    if (!snapshot) return;
    if (S.quota && snapshot.revision < S.quota.revision) return;
    S.quota = snapshot;
    updateStatus();
    rerender("overview", "quota");
  }

  async function loadTimeline(days, force) {
    const cur = S.timelines[days];
    if (cur && (cur.loading || (!force && cur.data && Date.now() - cur.at < 60_000))) return cur;
    S.timelines[days] = { ...(cur || {}), loading: true, error: null };
    try {
      const data = await api.tokens.timeline({
        days,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      });
      S.timelines[days] = { data, at: Date.now(), loading: false, error: null };
    } catch (e) {
      S.timelines[days] = {
        ...(cur || {}),
        loading: false,
        error: e && e.message ? e.message : String(e),
      };
    }
    rerender("overview", "usage");
    return S.timelines[days];
  }

  async function loadUsageAggregate(days, force) {
    const cur = S.usageAggregates[days];
    if (cur && (cur.loading || (!force && cur.aggregate && Date.now() - cur.at < 60_000))) return;
    S.usageAggregates[days] = { ...(cur || {}), loading: true };
    try {
      const untilMs = Date.now();
      const usage = await api.tokens.query({ sinceMs: untilMs - days * DAY_MS, untilMs });
      S.usageAggregates[days] = {
        aggregate: usage.aggregate || {},
        at: Date.now(),
        loading: false,
      };
    } catch (e) {
      S.usageAggregates[days] = {
        aggregate: null,
        at: Date.now(),
        loading: false,
        error: e.message,
      };
    }
    rerender("usage");
  }

  async function loadMerged() {
    S.mergedLoading = true;
    rerender("usage");
    try {
      S.merged = await api.tokens.merged();
    } catch (e) {
      toast(e.message, "error");
      S.merged = null;
    }
    S.mergedLoading = false;
    rerender("usage");
  }

  async function loadAlerts() {
    try {
      S.alerts = await api.alerts.list();
      receiveBudget(await api.alerts.state());
    } catch {
      /* the view shows the diagnostic from budget state when available */
    }
    rerender("alerts", "overview");
  }

  function receiveBudget(state) {
    if (!state) return;
    if (S.budget && state.revision < S.budget.revision) return;
    S.budget = state;
    if (state.evaluatedAt !== null) S.alerts = state.rules;
    rerender("alerts", "overview");
  }

  async function loadPricing() {
    try {
      const data = await api.pricing.list();
      S.pricing.overrides = data.overrides || [];
      S.pricing.snapshot = data.snapshot;
    } catch {
      /* keep previous */
    }
    S.pricing.loaded = true;
    rerender("settings");
  }

  async function loadApikeys() {
    try {
      S.apikeys = await api.apikeys.status();
    } catch {
      /* keep previous */
    }
    rerender("settings");
  }

  async function loadVersion() {
    try {
      S.version = await api.app.getVersion();
    } catch {
      S.version = null;
    }
    rerender("settings");
  }

  async function loadHistory() {
    const H = S.history;
    H.error = null;
    H.loading = true;
    rerender("quota");
    try {
      if (!H.providersLoaded) {
        H.providers = await api.dashboardHistory.listProviders();
        H.providersLoaded = true;
        // A provider chosen by a reset notice is kept even before it is listed.
        if (!H.provider && H.providers.length > 0) H.provider = H.providers[0];
      }
      H.events = api.resets ? await api.resets.events() : [];
      H.status = api.resets ? await api.resets.status() : "";
      if (H.provider) {
        const [quota, resets, accounting] = await Promise.all([
          api.dashboardHistory.quotaHistory(H.provider, H.days),
          api.dashboardHistory.weeklyResets(H.provider, Math.max(1, Math.ceil(H.days / 7))),
          api.dashboardHistory.accountingHistory(H.provider, H.days),
        ]);
        H.quota = quota || [];
        H.resets = resets || [];
        H.accounting = accounting || [];
      } else {
        H.quota = [];
        H.resets = [];
        H.accounting = [];
      }
      const untilMs = Date.now();
      const [range, burn] = await Promise.all([
        api.tokens.query({ sinceMs: untilMs - H.days * DAY_MS, untilMs }),
        // A local rolling lookback, never presented as a provider's fixed window.
        api.tokens.query({ sinceMs: untilMs - 5 * 3_600_000, untilMs }).catch(() => null),
      ]);
      H.sourceModels = (range.aggregate && range.aggregate.bySourceModel) || [];
      H.burning = (burn && burn.aggregate && burn.aggregate.bySession) || [];
    } catch {
      H.error = "History unavailable: local observations could not be read";
    }
    H.loading = false;
    rerender("quota");
  }

  async function loadSessions() {
    const SS = S.sessions;
    SS.error = null;
    SS.loading = true;
    rerender("sessions");
    try {
      SS.view = await api.sessions.report({
        days: SS.days,
        windows: SS.windows,
        imports: SS.imports,
      });
    } catch (e) {
      SS.error = e && e.message ? e.message : String(e);
    }
    SS.loading = false;
    rerender("sessions");
  }

  // ── Quota helpers (shared by Overview and Quota) ───────────────────────
  const WINDOW_TAG_ORDER = { "5h": 0, hourly: 0, daily: 1, weekly: 2, monthly: 3, yearly: 4 };

  function windowTag(entry) {
    const label = (entry.label || "").trim().replace(/:+$/, "").trim();
    return label || entry.name;
  }

  function usedOf(entry) {
    return 100 - Math.max(0, Math.min(100, entry.percentRemaining || 0));
  }

  /** Entries sharing a `group` render as one card with one row per window. */
  function groupEntries(entries) {
    const byGroup = new Map();
    const others = [];
    for (const e of entries) {
      const key = e.kind !== "value" && e.percentRemaining != null ? (e.group || "").trim() : "";
      if (!key) {
        others.push(e);
        continue;
      }
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(e);
    }
    const groups = [];
    for (const [key, list] of byGroup) {
      if (list.length >= 2) {
        list.sort(
          (a, b) =>
            (WINDOW_TAG_ORDER[windowTag(a).toLowerCase()] ?? 99) -
            (WINDOW_TAG_ORDER[windowTag(b).toLowerCase()] ?? 99),
        );
        groups.push({ name: key, windows: list });
      } else {
        others.push(...list);
      }
    }
    for (const e of others) groups.push({ name: e.name, windows: [e], single: true });
    // Value-only entries first, then the most constrained first.
    const worst = (g) => {
      const pct = g.windows.filter((w) => w.percentRemaining != null && w.kind !== "value");
      return pct.length ? Math.max(...pct.map(usedOf)) : 101;
    };
    return groups.sort((a, b) => worst(b) - worst(a));
  }

  /** Flat list of percent windows, most used first. */
  function quotaWindows(entries) {
    return (entries || [])
      .filter((e) => e.kind !== "value" && e.percentRemaining != null)
      .map((e) => ({
        entry: e,
        title: (e.group || "").trim() || e.name,
        tag: (e.group || "").trim() ? windowTag(e) : "",
        used: usedOf(e),
      }))
      .sort((a, b) => b.used - a.used);
  }

  function filterEntries(entries, filter) {
    if (filter === "all") return entries;
    return entries.filter((e) =>
      e.providerId
        ? e.providerId === filter
        : e.name && e.name.toLowerCase().includes(filter.toLowerCase()),
    );
  }

  /** A span kept current by tickCountdowns(); data-reset-at drives it. */
  function countdown(iso, prefix) {
    const p = prefix ?? "⟳ ";
    const text = fmt.countdown(iso);
    const span = el("span", {
      className: "countdown",
      title: iso ? "Resets " + new Date(iso).toLocaleString() : null,
    });
    if (iso) {
      span.dataset.resetAt = iso;
      span.dataset.prefix = p;
    }
    span.textContent = text ? p + text : "";
    return span;
  }

  function tickCountdowns() {
    for (const span of document.querySelectorAll("[data-reset-at]")) {
      const text = fmt.countdown(span.dataset.resetAt);
      span.textContent = text ? (span.dataset.prefix || "") + text : "";
    }
  }

  // ── Shared modals ──────────────────────────────────────────────────────
  function showAddPricingModal(provider, model) {
    const vals = { provider: provider || "", model: model || "", label: "" };
    const RATE_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"];
    for (const k of RATE_KEYS) vals[k] = "";
    ui.openModal("Add pricing override", (close) => {
      const text = (key, attrs) =>
        ui.input({
          type: "text",
          value: vals[key],
          onInput: (e) => (vals[key] = e.target.value),
          ...attrs,
        });
      const num = (key) =>
        ui.input({
          type: "number",
          min: "0",
          step: "any",
          placeholder: "$ / 1M",
          onInput: (e) => (vals[key] = e.target.value),
        });
      return {
        body: [
          el(
            "div",
            { className: "field-row" },
            ui.field("Provider", text("provider", { placeholder: "e.g. anthropic" })),
            ui.field("Model", text("model", { placeholder: "e.g. claude-sonnet" })),
          ),
          el(
            "div",
            { className: "field-grid" },
            ui.field("Input", num("input")),
            ui.field("Output", num("output")),
            ui.field("Cache read", num("cache_read")),
            ui.field("Cache write", num("cache_write")),
            ui.field("Reasoning", num("reasoning")),
          ),
          el(
            "div",
            { className: "field-hint" },
            "Rates are USD per one million tokens. Leave a rate empty to keep it unpriced.",
          ),
          ui.field("Label (optional)", text("label")),
        ],
        actions: [
          ui.button("Cancel", close, { small: true }),
          ui.button(
            "Save override",
            async () => {
              const rates = {};
              for (const k of RATE_KEYS) if (vals[k] !== "") rates[k] = parseFloat(vals[k]);
              try {
                await api.pricing.save({
                  provider: vals.provider,
                  model: vals.model,
                  rates,
                  label: vals.label || undefined,
                });
                toast("Override saved");
                close();
                // Costs change with the new rate.
                S.timelines = {};
                S.usageAggregates = {};
                await loadPricing();
              } catch (e) {
                toast(e.message, "error");
              }
            },
            { kind: "primary", small: true },
          ),
        ],
      };
    });
  }

  const METRICS = [
    ["cost_usd", "Estimated cost (USD)"],
    ["tokens_total", "Total tokens"],
    ["tokens_input", "Input tokens"],
    ["tokens_output", "Output tokens"],
  ];
  const WINDOWS = [
    ["day", "Per day"],
    ["week", "Per week"],
    ["month", "Per month"],
    ["all", "All time"],
  ];

  function formatMetricValue(metric, value) {
    if (value == null || !Number.isFinite(Number(value))) return TW.NA;
    return metric === "cost_usd" ? fmt.usd(Number(value)) : fmt.compact(Number(value));
  }

  function describeRule(r) {
    const metric = (METRICS.find(([k]) => k === r.metric) || [
      r.metric,
      String(r.metric || "").replace(/_/g, " "),
    ])[1].toLowerCase();
    const scope =
      r.scope && r.scope.type === "model"
        ? "model " + (r.scope.providerId ? r.scope.providerId + "/" : "") + (r.scope.modelId || "?")
        : r.scope && r.scope.type === "provider"
          ? "provider " + (r.scope.providerId || "?")
          : "all usage";
    const win = (WINDOWS.find(([k]) => k === r.window) || [r.window, r.window])[1].toLowerCase();
    return (
      "Alert when " +
      metric +
      " is " +
      (r.direction || "above") +
      " " +
      formatMetricValue(r.metric, r.threshold) +
      " · " +
      win +
      " · " +
      scope
    );
  }

  function showCreateAlertModal() {
    const v = {
      name: "",
      scopeType: "global",
      providerId: "",
      modelId: "",
      window: "day",
      metric: "cost_usd",
      threshold: 5,
      direction: "above",
    };
    ui.openModal("New budget alert", (close) => {
      const scopeFields = el("div", { className: "field-row" });
      const preview = el("div", { className: "rule-preview" });
      const paintPreview = () => {
        preview.textContent = describeRule({
          metric: v.metric,
          threshold: v.threshold,
          direction: v.direction,
          window: v.window,
          scope: { type: v.scopeType, providerId: v.providerId, modelId: v.modelId },
        });
      };
      // Provider/model inputs appear only for the scopes that use them.
      const syncScope = () => {
        clear(scopeFields);
        if (v.scopeType !== "global")
          scopeFields.appendChild(
            ui.field(
              "Provider ID",
              ui.input({
                type: "text",
                value: v.providerId,
                placeholder: "e.g. anthropic",
                onInput: (e) => ((v.providerId = e.target.value), paintPreview()),
              }),
            ),
          );
        if (v.scopeType === "model")
          scopeFields.appendChild(
            ui.field(
              "Model ID",
              ui.input({
                type: "text",
                value: v.modelId,
                placeholder: "e.g. claude-sonnet",
                onInput: (e) => ((v.modelId = e.target.value), paintPreview()),
              }),
            ),
          );
        paintPreview();
      };
      const body = [
        ui.field(
          "Name",
          ui.input({
            type: "text",
            placeholder: "e.g. Daily spend cap",
            onInput: (e) => (v.name = e.target.value),
          }),
        ),
        el(
          "div",
          { className: "field-row" },
          ui.field(
            "Metric",
            ui.select(METRICS, v.metric, (x) => ((v.metric = x), paintPreview())),
          ),
          ui.field(
            "Window",
            ui.select(WINDOWS, v.window, (x) => ((v.window = x), paintPreview())),
          ),
        ),
        el(
          "div",
          { className: "field-row" },
          ui.field(
            "Direction",
            ui.select(
              [
                ["above", "Above"],
                ["below", "Below"],
              ],
              v.direction,
              (x) => ((v.direction = x), paintPreview()),
            ),
          ),
          ui.field(
            "Threshold",
            ui.input({
              type: "number",
              min: "0",
              step: "any",
              value: String(v.threshold),
              onInput: (e) => ((v.threshold = parseFloat(e.target.value) || 0), paintPreview()),
            }),
          ),
        ),
        ui.field(
          "Scope",
          ui.select(
            [
              ["global", "All usage"],
              ["provider", "One provider"],
              ["model", "One model"],
            ],
            v.scopeType,
            (x) => ((v.scopeType = x), syncScope()),
          ),
        ),
        scopeFields,
        preview,
      ];
      syncScope();
      return {
        body,
        actions: [
          ui.button("Cancel", close, { small: true }),
          ui.button(
            "Create alert",
            async () => {
              try {
                await api.alerts.create({
                  name: v.name || "New alert",
                  scope: {
                    type: v.scopeType,
                    providerId: v.providerId || undefined,
                    modelId: v.modelId || undefined,
                  },
                  window: v.window,
                  metric: v.metric,
                  threshold: v.threshold,
                  direction: v.direction,
                });
                toast("Alert created");
                close();
                await loadAlerts();
              } catch (e) {
                toast(e.message, "error");
              }
            },
            { kind: "primary", small: true },
          ),
        ],
      };
    });
  }

  function showPassphraseModal(title, desc, onConfirm) {
    let pass = "";
    ui.openModal(title, (close) => {
      const submit = async () => {
        try {
          await onConfirm(pass);
          close();
        } catch (e) {
          toast(e.message, "error");
        }
      };
      return {
        body: [
          desc ? el("div", { className: "modal-desc" }, desc) : null,
          ui.field(
            "Passphrase",
            ui.input({
              type: "password",
              placeholder: "Enter passphrase",
              onInput: (e) => (pass = e.target.value),
              onKeydown: (e) => {
                if (e.key === "Enter") submit();
              },
            }),
          ),
        ],
        actions: [
          ui.button("Cancel", close, { small: true }),
          ui.button("Confirm", submit, { kind: "primary", small: true }),
        ],
      };
    });
  }

  function showAddKeyModal() {
    const v = { providerId: "", apiKey: "", label: "" };
    ui.openModal("Add API key", (close) => ({
      body: [
        ui.field(
          "Provider ID",
          ui.input({
            type: "text",
            placeholder: "e.g. openai, anthropic",
            onInput: (e) => (v.providerId = e.target.value),
          }),
        ),
        ui.field(
          "API key",
          ui.input({
            type: "password",
            placeholder: "sk-…",
            onInput: (e) => (v.apiKey = e.target.value),
          }),
        ),
        ui.field(
          "Label (optional)",
          ui.input({
            type: "text",
            placeholder: "e.g. Work account",
            onInput: (e) => (v.label = e.target.value),
          }),
        ),
      ],
      actions: [
        ui.button("Cancel", close, { small: true }),
        ui.button(
          "Save key",
          async () => {
            try {
              await api.apikeys.save(v.providerId, v.apiKey, v.label || undefined);
              toast("API key saved");
              close();
              await loadApikeys();
            } catch (e) {
              toast(e.message, "error");
            }
          },
          { kind: "primary", small: true },
        ),
      ],
    }));
  }

  // ── Theme ──────────────────────────────────────────────────────────────
  function applyTheme() {
    if (S.theme === "light" || S.theme === "dark")
      document.documentElement.setAttribute("data-theme", S.theme);
    else document.documentElement.removeAttribute("data-theme");
  }

  function setTheme(theme) {
    S.theme = theme;
    if (theme === "system") localStorage.removeItem("quota-theme");
    else localStorage.setItem("quota-theme", theme);
    applyTheme();
    renderView();
  }

  // ── Context handed to views ────────────────────────────────────────────
  const ctx = {
    api,
    S,
    DAY_MS,
    go,
    rerender,
    renderView,
    load: {
      quota: refreshQuota,
      timeline: loadTimeline,
      usageAggregate: loadUsageAggregate,
      merged: loadMerged,
      alerts: loadAlerts,
      pricing: loadPricing,
      apikeys: loadApikeys,
      version: loadVersion,
      history: loadHistory,
      sessions: loadSessions,
    },
    quota: { groupEntries, quotaWindows, filterEntries, windowTag, usedOf, countdown },
    modals: {
      addPricing: showAddPricingModal,
      createAlert: showCreateAlertModal,
      passphrase: showPassphraseModal,
      addKey: showAddKeyModal,
    },
    describeRule,
    formatMetricValue,
    setTheme,
  };
  TW.ctx = ctx;

  // Escape closes the topmost modal.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlays = document.querySelectorAll(".modal-overlay");
    if (overlays.length) overlays[overlays.length - 1].remove();
  });

  // ── Init ───────────────────────────────────────────────────────────────
  function init() {
    const saved = localStorage.getItem("quota-theme");
    S.theme = saved === "light" || saved === "dark" ? saved : "system";
    applyTheme();
    renderShell();
    if (view(S.tab).enter) view(S.tab).enter(ctx, {});

    const unsubscribeResets = api.resets?.onOpen((selection) => {
      const H = S.history;
      H.provider = selection.providerId;
      H.account = selection.accountIdentity;
      H.window = selection.windowId;
      go("quota", { focusHistory: true });
    });
    const unsubscribeQuota = api.quota.onUpdate(receiveQuota);
    api.quota
      .state()
      .then(receiveQuota)
      .catch((e) => toast(e.message, "error"));
    const unsubscribeBudgets = api.alerts.onUpdate(receiveBudget);
    const unsubscribeHistory = api.dashboardHistory.onUpdate(() => {
      S.history.providersLoaded = false;
      if (S.tab === "quota") loadHistory();
    });
    loadAlerts();
    loadPricing();
    loadApikeys();
    loadVersion();

    // Keep reset countdowns current between quota refreshes without re-rendering.
    const countdownTimer = setInterval(tickCountdowns, 30_000);
    // Charts resolve colors through CSS variables; repaint when the system scheme flips.
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const onScheme = () => {
      if (S.theme === "system") renderView();
    };
    if (media && media.addEventListener) media.addEventListener("change", onScheme);
    window.addEventListener(
      "beforeunload",
      () => {
        unsubscribeQuota();
        unsubscribeBudgets();
        unsubscribeHistory();
        if (unsubscribeResets) unsubscribeResets();
        clearInterval(countdownTimer);
        if (media && media.removeEventListener) media.removeEventListener("change", onScheme);
      },
      { once: true },
    );
    if (api.app.onRefresh) api.app.onRefresh(() => refreshQuota());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
