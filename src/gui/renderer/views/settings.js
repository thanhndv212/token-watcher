/**
 * Settings — pricing (snapshot + overrides), the encrypted API-key store,
 * appearance and version. Pricing changes invalidate cached usage so every
 * cost figure is recomputed with the new rates.
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, fmt, charts } = TW;
  const ui = TW.ui;
  TW.views = TW.views || {};

  const RATE_KEYS = [
    ["input", "In"],
    ["output", "Out"],
    ["cache_read", "Cache R"],
    ["cache_write", "Cache W"],
    ["reasoning", "Reason"],
  ];

  function invalidateUsage(ctx) {
    ctx.S.timelines = {};
    ctx.S.usageAggregates = {};
  }

  function snapshotCard(ctx) {
    const P = ctx.S.pricing;
    const snap = P.snapshot;
    return ui.card(
      {
        title: "Pricing Snapshot",
        subtitle: "Model rates from models.dev, used for every cost estimate",
        actions: [
          snap ? ui.pill(snap.stale ? "warning" : "ok", snap.stale ? "STALE" : "FRESH") : null,
          ui.button(
            P.refreshing ? "Refreshing…" : "⟳ Refresh rates",
            async () => {
              P.refreshing = true;
              ctx.renderView();
              try {
                const r = await ctx.api.pricing.refreshSnapshot();
                if (r && r.success === false)
                  TW.toast("Pricing refresh failed: " + (r.error || "unknown error"), "error");
                else TW.toast("Pricing refreshed", "success");
                invalidateUsage(ctx);
                await ctx.load.pricing();
              } catch (e) {
                TW.toast(e.message, "error");
              }
              P.refreshing = false;
              ctx.renderView();
            },
            { small: true, disabled: P.refreshing },
          ),
        ],
      },
      snap
        ? el(
            "div",
            { className: "kv-grid" },
            ui.kv(
              "Updated",
              snap.generatedAt
                ? new Date(snap.generatedAt).toLocaleDateString() +
                    " (" +
                    fmt.ago(new Date(snap.generatedAt).getTime()) +
                    ")"
                : "never",
            ),
            ui.kv("Providers", fmt.integer(snap.providerCount || 0)),
            ui.kv("Models", fmt.integer(snap.modelCount || 0)),
          )
        : el(
            "div",
            { className: "muted" },
            P.loaded ? "No pricing snapshot information available." : "Loading…",
          ),
    );
  }

  function overridesCard(ctx) {
    const P = ctx.S.pricing;
    const rows = P.overrides || [];
    return ui.card(
      {
        title: "Price overrides",
        subtitle:
          rows.length +
          " override" +
          (rows.length !== 1 ? "s" : "") +
          " · USD per million tokens; overrides win over the snapshot",
        actions: ui.button("+ Add", () => ctx.modals.addPricing(), {
          kind: "primary",
          small: true,
        }),
      },
      rows.length
        ? charts.table(
            [
              {
                key: "model",
                label: "Model",
                className: "cell-strong",
                format: (v, r) => r.provider + "/" + v + (r.label ? " · " + r.label : ""),
              },
              ...RATE_KEYS.map(([k, l]) => ({
                key: k,
                label: l,
                numeric: true,
                format: (v) => (v == null ? TW.NA : "$" + Number(v).toFixed(2)),
              })),
              {
                key: "actions",
                label: "",
                sortable: false,
                format: (_, r) =>
                  el(
                    "button",
                    {
                      className: "link-btn danger",
                      title: "Remove override",
                      onClick: async (e) => {
                        e.stopPropagation();
                        try {
                          await ctx.api.pricing.delete(r.provider, r.model);
                          TW.toast("Override removed", "success");
                          invalidateUsage(ctx);
                          await ctx.load.pricing();
                        } catch (err) {
                          TW.toast(err.message, "error");
                        }
                      },
                    },
                    "Remove",
                  ),
              },
            ],
            rows.map((o) => ({ ...o, ...(o.rates || {}) })),
            { sortKey: "model", sortDir: "asc" },
          )
        : el(
            "div",
            { className: "muted" },
            "No overrides. Unpriced models in Usage offer an “Add price” shortcut.",
          ),
    );
  }

  async function exportKeys(ctx) {
    ctx.modals.passphrase(
      "Export key bundle",
      "Choose a passphrase to encrypt the exported bundle. Share it separately from the file.",
      async (pass) => {
        const result = await ctx.api.apikeys.export(pass);
        const blob = new Blob([JSON.stringify(result.bundle, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = el("a", { href: url, download: result.defaultFileName });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        TW.toast("Key bundle exported", "success");
      },
    );
  }

  function apiKeysCard(ctx) {
    const st = ctx.S.apikeys;
    const title = "API keys";
    if (!st) return ui.card({ title }, ui.loading("Checking key store…"));
    if (st.state === "empty")
      return ui.card(
        { title, subtitle: "Encrypted locally with a passphrase" },
        ui.empty(
          "⚿",
          "No API key store found",
          "Create one to keep provider API keys encrypted on this machine.",
          ui.button(
            "Create Key Store",
            () =>
              ctx.modals.passphrase(
                "Create key store",
                "This passphrase encrypts your keys. It cannot be recovered.",
                async (pass) => {
                  await ctx.api.apikeys.init(pass);
                  TW.toast("Key store initialized", "success");
                  await ctx.load.apikeys();
                },
              ),
            { kind: "primary" },
          ),
        ),
      );
    if (st.state === "locked")
      return ui.card(
        {
          title,
          subtitle: fmt.integer(st.providerCount || 0) + " provider key(s) stored",
          actions: ui.pill("neutral", "Locked", "🔒"),
        },
        ui.button(
          "Unlock with Passphrase",
          () =>
            ctx.modals.passphrase("Unlock key store", null, async (pass) => {
              await ctx.api.apikeys.unlock(pass);
              TW.toast("Key store unlocked", "success");
              await ctx.load.apikeys();
            }),
          { kind: "primary" },
        ),
      );
    const providers = st.providers || [];
    return ui.card(
      {
        title,
        subtitle: providers.length + " key(s) · unlocked",
        actions: [
          ui.button("+ Add key", () => ctx.modals.addKey(), { kind: "primary", small: true }),
          ui.button("Export", () => exportKeys(ctx), { small: true }),
          ui.button(
            "Lock",
            async () => {
              await ctx.api.apikeys.lock();
              await ctx.load.apikeys();
            },
            { small: true },
          ),
        ],
      },
      providers.length
        ? charts.table(
            [
              {
                key: "providerId",
                label: "Provider",
                className: "cell-strong",
                format: (v, r) => (r.label ? v + " · " + r.label : v),
              },
              {
                key: "hasKey",
                label: "Key",
                format: (v) => (v ? ui.pill("ok", "Stored") : ui.pill("neutral", "Missing")),
              },
              {
                key: "updatedAt",
                label: "Updated",
                format: (v) => (v ? new Date(v).toLocaleDateString() : TW.NA),
              },
              {
                key: "actions",
                label: "",
                sortable: false,
                format: (_, r) =>
                  el(
                    "button",
                    {
                      className: "link-btn danger",
                      onClick: async () => {
                        if (!window.confirm("Delete the stored key for " + r.providerId + "?"))
                          return;
                        try {
                          await ctx.api.apikeys.delete(r.providerId);
                          TW.toast("Key deleted", "success");
                          await ctx.load.apikeys();
                        } catch (e) {
                          TW.toast(e.message, "error");
                        }
                      },
                    },
                    "Delete",
                  ),
              },
            ],
            providers,
            { sortKey: "providerId", sortDir: "asc" },
          )
        : el("div", { className: "muted" }, "No API keys stored"),
    );
  }

  function appearanceCard(ctx) {
    return ui.card(
      { title: "Appearance" },
      el(
        "div",
        { className: "setting-row" },
        el("span", {}, "Theme"),
        ui.segmented(
          [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          ctx.S.theme,
          (v) => ctx.setTheme(v),
          { small: true, label: "Theme" },
        ),
      ),
      el(
        "div",
        { className: "card-note" },
        "Token Watcher " +
          (ctx.S.version ? "v" + ctx.S.version : "") +
          " · all figures are computed locally; nothing here calls a model.",
      ),
    );
  }

  TW.views.settings = {
    label: "Settings",
    icon: "⚙",
    title: "Settings",
    enter(ctx) {
      ctx.load.pricing();
      ctx.load.apikeys();
    },
    refresh(ctx) {
      return Promise.all([ctx.load.pricing(), ctx.load.apikeys()]);
    },
    render(ctx, page) {
      page.appendChild(ui.sectionTitle("Pricing"));
      page.appendChild(
        el("div", { className: "grid grid-2" }, snapshotCard(ctx), overridesCard(ctx)),
      );
      page.appendChild(ui.sectionTitle("Keys & appearance"));
      page.appendChild(
        el("div", { className: "grid grid-2" }, apiKeysCard(ctx), appearanceCard(ctx)),
      );
    },
  };
})();
