/**
 * Token Watcher renderer — core helpers (DOM, formatting, tooltip).
 *
 * Classic script (no bundler, CSP `script-src 'self'`); everything hangs off
 * `window.TW` so the view and chart files can share it.
 */
(function () {
  "use strict";
  const TW = (window.TW = window.TW || {});

  // ── DOM ────────────────────────────────────────────────────────────────
  const SVG_NS = "http://www.w3.org/2000/svg";

  function applyAttrs(node, attrs, isSvg) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "className") {
        if (isSvg) node.setAttribute("class", v);
        else node.className = v;
      } else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith("--")) node.style.setProperty(sk, sv);
          else node.style[sk] = sv;
        }
      } else if (k === "dataset" && typeof v === "object") {
        Object.assign(node.dataset, v);
      } else if (v === true) {
        node.setAttribute(k, "");
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }

  function append(node, children) {
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(node, c);
      else node.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    }
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    applyAttrs(node, attrs, false);
    append(node, children);
    return node;
  }

  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs, true);
    append(node, children);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // ── Formatting ─────────────────────────────────────────────────────────
  const NA = "n/a";

  function compact(n) {
    if (n == null || !Number.isFinite(n)) return NA;
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    // Trim zeros only after a decimal point: "2.50" → "2.5", "3.00" → "3", but "300" stays.
    const fix = (v) =>
      (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(
        /\.(\d*?)0+$/,
        (_, d) => (d ? "." + d : ""),
      );
    const units = [
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"],
    ];
    for (let i = 0; i < units.length; i++) {
      const [base, suffix] = units[i];
      if (abs < base) continue;
      const text = fix(abs / base);
      // 999.6K rounds to "1000K"; promote to the next unit instead.
      if (text === "1000" && i > 0) return sign + "1" + units[i - 1][1];
      return sign + text + suffix;
    }
    if (Math.round(abs) === 1000) return sign + "1K";
    return sign + Math.round(abs).toLocaleString();
  }

  function integer(n) {
    if (n == null || !Number.isFinite(n)) return NA;
    return Math.round(n).toLocaleString();
  }

  function usd(n, opts) {
    if (n == null || !Number.isFinite(n)) return NA;
    const abs = Math.abs(n);
    if (opts && opts.compact && abs >= 10_000) return (n < 0 ? "-$" : "$") + compact(abs);
    if (abs > 0 && abs < 0.01) return "<$0.01";
    return (
      (n < 0 ? "-$" : "$") +
      abs.toLocaleString(undefined, {
        minimumFractionDigits: abs >= 1000 ? 0 : 2,
        maximumFractionDigits: abs >= 1000 ? 0 : 2,
      })
    );
  }

  function pct(share, digits) {
    if (share == null || !Number.isFinite(share)) return NA;
    const v = share * 100;
    const d = digits ?? (v > 0 && v < 1 ? 1 : 0);
    return v.toFixed(d) + "%";
  }

  /** Signed relative change, e.g. "+12%" / "−8%"; null when the base is 0. */
  function delta(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
    return (current - previous) / previous;
  }

  function signedPct(share) {
    if (share == null) return "";
    const v = Math.round(share * 100);
    return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v) + "%";
  }

  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const totalMin = Math.max(1, Math.floor(ms / 60000));
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }

  function countdown(iso) {
    if (!iso) return "";
    const diff = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return "";
    return duration(diff);
  }

  function ago(ms) {
    if (!ms) return "never";
    const diff = Date.now() - ms;
    if (diff < 45_000) return "just now";
    return duration(diff) + " ago";
  }

  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function shortDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function dayLabel(dayKey) {
    // dayKey is local YYYY-MM-DD; build a local date for display.
    const [y, m, d] = dayKey.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function hourLabel(h) {
    return String(h).padStart(2, "0") + ":00";
  }

  function dateTime(ms) {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ── Domain vocabulary ──────────────────────────────────────────────────
  const SOURCES = [
    { key: "opencode", label: "OpenCode", color: "var(--s1)" },
    { key: "claude-code", label: "Claude Code", color: "var(--s2)" },
    { key: "codex", label: "Codex", color: "var(--s3)" },
  ];
  const SOURCE_BY_KEY = Object.fromEntries(SOURCES.map((s) => [s.key, s]));

  const TOKEN_TYPES = [
    { key: "input", label: "Input", color: "var(--s1)" },
    { key: "output", label: "Output", color: "var(--s2)" },
    { key: "cache_read", label: "Cache read", color: "var(--s3)" },
    { key: "cache_write", label: "Cache write", color: "var(--s4)" },
    { key: "reasoning", label: "Reasoning", color: "var(--s5)" },
  ];

  function sumTokens(t) {
    if (!t) return 0;
    return (
      (t.input || 0) +
      (t.output || 0) +
      (t.cache_read || 0) +
      (t.cache_write || 0) +
      (t.reasoning || 0)
    );
  }

  /** cache_read / (input + cache_read + cache_write); null when that is 0. */
  function cacheReadShare(t) {
    if (!t) return null;
    const denom = (t.input || 0) + (t.cache_read || 0) + (t.cache_write || 0);
    return denom > 0 ? (t.cache_read || 0) / denom : null;
  }

  function providerLabel(id) {
    const p = (id || "").toLowerCase();
    if (p.includes("opencode")) return "OpenCode";
    if (p.includes("cursor")) return "Cursor";
    if (p.includes("claude") || p.includes("anthropic")) return "Claude";
    if (p.includes("github") || p.includes("copilot")) return "Copilot";
    if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex")) return "OpenAI";
    if (p.includes("google") || p.includes("antigravity") || p.includes("gemini")) return "Google";
    if (p.includes("azure")) return "Azure";
    return id || "Unknown";
  }

  /** Quota severity from percent used; status colors always ship with a label. */
  function severity(used) {
    if (used >= 90) return { key: "critical", label: "Critical", icon: "▲" };
    if (used >= 75) return { key: "warning", label: "High", icon: "●" };
    return { key: "ok", label: "OK", icon: "" };
  }

  // ── Tooltip (one shared, cursor-following) ─────────────────────────────
  let tipNode = null;

  function tooltipNode() {
    if (!tipNode) {
      tipNode = el("div", { className: "tw-tooltip", role: "tooltip" });
      document.body.appendChild(tipNode);
    }
    return tipNode;
  }

  /**
   * rows: [{ label, value, color?, strong? }]
   */
  function showTooltip(event, title, rows, footer) {
    const tip = tooltipNode();
    clear(tip);
    if (title) tip.appendChild(el("div", { className: "tw-tooltip-title" }, title));
    for (const r of rows || []) {
      tip.appendChild(
        el(
          "div",
          { className: "tw-tooltip-row" + (r.strong ? " strong" : "") },
          r.color
            ? el("span", { className: "swatch", style: { background: r.color } })
            : el("span", { className: "swatch empty" }),
          el("span", { className: "label" }, r.label),
          el("span", { className: "value" }, r.value),
        ),
      );
    }
    if (footer) tip.appendChild(el("div", { className: "tw-tooltip-foot" }, footer));
    tip.classList.add("visible");
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const tip = tooltipNode();
    if (!tip.classList.contains("visible")) return;
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 4) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 4) y = event.clientY - rect.height - pad;
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = Math.max(4, y) + "px";
  }

  function hideTooltip() {
    if (tipNode) tipNode.classList.remove("visible");
  }

  /** Attach a hover tooltip to any node; `content()` returns [title, rows, footer]. */
  function hoverTip(node, content) {
    node.addEventListener("mouseenter", (e) => showTooltip(e, ...content()));
    node.addEventListener("mousemove", moveTooltip);
    node.addEventListener("mouseleave", hideTooltip);
    node.addEventListener("focus", () => {
      const r = node.getBoundingClientRect();
      showTooltip({ clientX: r.right, clientY: r.top }, ...content());
    });
    node.addEventListener("blur", hideTooltip);
    return node;
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(message, type) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    if (toastTimer) clearTimeout(toastTimer);
    const node = el(
      "div",
      {
        className: "toast " + (type === "error" ? "toast-error" : "toast-success"),
        role: "status",
      },
      el("span", { className: "toast-icon" }, type === "error" ? "✕" : "✓"),
      message,
    );
    document.body.appendChild(node);
    toastTimer = setTimeout(() => node.remove(), 3200);
  }

  Object.assign(TW, {
    el,
    svg,
    clear,
    NA,
    fmt: {
      compact,
      integer,
      usd,
      pct,
      delta,
      signedPct,
      duration,
      countdown,
      ago,
      shortDate,
      dayLabel,
      hourLabel,
      dateTime,
      WEEKDAYS,
    },
    SOURCES,
    SOURCE_BY_KEY,
    TOKEN_TYPES,
    sumTokens,
    cacheReadShare,
    providerLabel,
    severity,
    showTooltip,
    moveTooltip,
    hideTooltip,
    hoverTip,
    toast,
  });
})();
