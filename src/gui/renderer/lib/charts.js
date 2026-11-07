/**
 * Token Watcher renderer — chart primitives.
 *
 * Hand-rolled SVG/HTML charts (no library; CSP forbids remote code). Specs:
 * thin marks (bars ≤ 24px, 4px rounded data-end, square at the baseline),
 * 2px lines, ≥ 8px markers with a 2px surface ring, a 2px surface gap between
 * stacked segments, hairline solid gridlines, text in ink tokens only, and a
 * hover tooltip on every plotted mark. Colors are CSS variables so light/dark
 * swap in one place (see styles/app.css).
 */
(function () {
  "use strict";
  const TW = window.TW;
  const { el, svg, clear, fmt, showTooltip, moveTooltip, hideTooltip, hoverTip } = TW;

  // ── Layout helpers ─────────────────────────────────────────────────────

  /** A host that re-draws at its own width (ResizeObserver), so charts are responsive. */
  function responsive(height, draw, className) {
    const host = el("div", {
      className: "chart-host " + (className || ""),
      style: { height: height + "px" },
    });
    let lastWidth = 0;
    const paint = () => {
      const width = Math.floor(host.clientWidth);
      if (!width || width === lastWidth) return;
      lastWidth = width;
      clear(host);
      const node = draw(width, height);
      if (node) host.appendChild(node);
    };
    const ro = new ResizeObserver(paint);
    ro.observe(host);
    // Paint once attached even if the observer is slow to fire.
    requestAnimationFrame(paint);
    return host;
  }

  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  }

  /** Clean ticks from 0 to ≥ max. */
  function niceTicks(max, count) {
    if (!(max > 0)) return [0, 1];
    const step = niceStep(max / (count || 4));
    const ticks = [];
    for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  /** Rect with only the top corners rounded (data-end), square at the baseline. */
  function topRoundedRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    return (
      `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}` +
      `H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
    );
  }

  function legend(series, opts) {
    return el(
      "div",
      { className: "legend" + (opts && opts.inline ? " inline" : "") },
      series.map((s) =>
        el(
          "span",
          { className: "legend-item" },
          el("span", {
            className: "swatch" + (s.kind === "line" ? " line" : ""),
            style: { background: s.color },
          }),
          s.label,
        ),
      ),
    );
  }

  // ── Stacked columns (time on x) ────────────────────────────────────────
  /**
   * opts: {
   *   data: [{ key, label, values: { [seriesKey]: number } }],
   *   series: [{ key, label, color }],
   *   height, format, xTick(d, i, n) → string|null,
   *   footer(d) → string, emphasizeLast: boolean
   * }
   */
  function columns(opts) {
    const { data, series } = opts;
    const format = opts.format || fmt.compact;
    const height = opts.height || 168;
    return responsive(height, (width) => {
      const m = { top: 8, right: 4, bottom: 20, left: 40 };
      const iw = width - m.left - m.right;
      const ih = height - m.top - m.bottom;
      const totals = data.map((d) => series.reduce((s, ser) => s + (d.values[ser.key] || 0), 0));
      const ticks = niceTicks(Math.max(...totals, 0), 4);
      const yMax = ticks[ticks.length - 1] || 1;
      const y = (v) => m.top + ih - (v / yMax) * ih;
      const band = iw / Math.max(1, data.length);
      const bw = Math.max(2, Math.min(24, band * 0.68));
      const root = svg("svg", { width, height, className: "chart", role: "img" });

      for (const t of ticks) {
        root.appendChild(
          svg("line", {
            x1: m.left,
            x2: width - m.right,
            y1: y(t),
            y2: y(t),
            className: t === 0 ? "axis" : "grid",
          }),
        );
        root.appendChild(
          svg(
            "text",
            { x: m.left - 6, y: y(t) + 3.5, className: "tick", "text-anchor": "end" },
            format(t),
          ),
        );
      }

      data.forEach((d, i) => {
        const cx = m.left + band * i + band / 2;
        const x = cx - bw / 2;
        const g = svg("g", {
          className: "col" + (opts.emphasizeLast && i === data.length - 1 ? " current" : ""),
        });
        let acc = 0;
        const visible = series.filter((s) => (d.values[s.key] || 0) > 0);
        visible.forEach((s, si) => {
          const v = d.values[s.key] || 0;
          const y0 = y(acc);
          const y1 = y(acc + v);
          acc += v;
          const isTop = si === visible.length - 1;
          // 2px surface gap between stacked segments.
          const h = Math.max(0, y0 - y1 - (si > 0 ? 2 : 0));
          if (h <= 0) return;
          const top = y1;
          const node = isTop
            ? svg("path", { d: topRoundedRect(x, top, bw, h, 4) })
            : svg("rect", { x, y: top, width: bw, height: h });
          node.style.fill = s.color;
          g.appendChild(node);
        });
        // Hit target: the full band, taller and wider than the mark.
        const hit = svg("rect", {
          x: m.left + band * i,
          y: m.top,
          width: band,
          height: ih,
          className: "hit",
          tabindex: 0,
        });
        hoverTip(hit, () => [
          d.label,
          [
            ...series
              .filter((s) => (d.values[s.key] || 0) > 0)
              .map((s) => ({ label: s.label, value: format(d.values[s.key]), color: s.color }))
              .reverse(),
            ...(series.length > 1
              ? [{ label: "Total", value: format(totals[i]), strong: true }]
              : []),
          ],
          opts.footer ? opts.footer(d) : null,
        ]);
        hit.addEventListener("mouseenter", () => g.classList.add("hover"));
        hit.addEventListener("mouseleave", () => g.classList.remove("hover"));
        root.appendChild(g);
        root.appendChild(hit);

        const tick = opts.xTick ? opts.xTick(d, i, data.length, band) : null;
        if (tick)
          root.appendChild(
            svg("text", { x: cx, y: height - 5, className: "tick", "text-anchor": "middle" }, tick),
          );
      });
      return root;
    });
  }

  // ── Line chart with crosshair ──────────────────────────────────────────
  /**
   * opts: {
   *   series: [{ key, label, color, points: [{ t, v }] }],
   *   xDomain: [t0, t1], yMax?, yFormat, height,
   *   markers: [{ t, label }], tooltipTitle(t)
   * }
   */
  function line(opts) {
    const height = opts.height || 160;
    const yFormat = opts.yFormat || fmt.compact;
    return responsive(height, (width) => {
      const m = { top: 10, right: 10, bottom: 20, left: 36 };
      const iw = width - m.left - m.right;
      const ih = height - m.top - m.bottom;
      const all = opts.series.flatMap((s) => s.points);
      const [t0, t1] = opts.xDomain || [
        Math.min(...all.map((p) => p.t)),
        Math.max(...all.map((p) => p.t)),
      ];
      const span = Math.max(1, t1 - t0);
      const ticks = opts.yMax
        ? niceTicks(opts.yMax, 4)
        : niceTicks(Math.max(...all.map((p) => p.v), 0), 4);
      const yMax = opts.yMax || ticks[ticks.length - 1] || 1;
      const x = (t) => m.left + ((t - t0) / span) * iw;
      const y = (v) => m.top + ih - (Math.max(0, Math.min(yMax, v)) / yMax) * ih;
      const root = svg("svg", { width, height, className: "chart", role: "img" });

      for (const t of ticks.filter((v) => v <= yMax)) {
        root.appendChild(
          svg("line", {
            x1: m.left,
            x2: width - m.right,
            y1: y(t),
            y2: y(t),
            className: t === 0 ? "axis" : "grid",
          }),
        );
        root.appendChild(
          svg(
            "text",
            { x: m.left - 6, y: y(t) + 3.5, className: "tick", "text-anchor": "end" },
            yFormat(t),
          ),
        );
      }
      // X ticks: start / middle / end dates.
      [t0, t0 + span / 2, t1].forEach((t, i) =>
        root.appendChild(
          svg(
            "text",
            {
              x: x(t),
              y: height - 5,
              className: "tick",
              "text-anchor": i === 0 ? "start" : i === 2 ? "end" : "middle",
            },
            fmt.shortDate(t),
          ),
        ),
      );

      for (const mk of opts.markers || []) {
        if (mk.t < t0 || mk.t > t1) continue;
        root.appendChild(
          svg("line", {
            x1: x(mk.t),
            x2: x(mk.t),
            y1: m.top,
            y2: m.top + ih,
            className: "marker-line",
          }),
        );
      }

      for (const s of opts.series) {
        if (!s.points.length) continue;
        const pts = [...s.points].sort((a, b) => a.t - b.t);
        // Split into segments wherever observations are further apart than
        // opts.gapMs, so a missing stretch is drawn as missing, not interpolated.
        const segments = [];
        for (const p of pts) {
          const seg = segments[segments.length - 1];
          if (seg && !(opts.gapMs && p.t - seg[seg.length - 1].t > opts.gapMs)) seg.push(p);
          else segments.push([p]);
        }
        const segPath = (seg) =>
          seg.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p.v).toFixed(1)).join("");
        const d = segments.map(segPath).join("");
        // Area wash (~10%) + 2px line.
        for (const seg of segments) {
          const area = svg("path", {
            d:
              segPath(seg) +
              `L${x(seg[seg.length - 1].t).toFixed(1)},${y(0)}L${x(seg[0].t).toFixed(1)},${y(0)}Z`,
            className: "area",
          });
          area.style.fill = s.color;
          root.appendChild(area);
        }
        const path = svg("path", { d, className: "line" });
        path.style.stroke = s.color;
        root.appendChild(path);
        const last = pts[pts.length - 1];
        const dot = svg("circle", { cx: x(last.t), cy: y(last.v), r: 4, className: "dot" });
        dot.style.fill = s.color;
        root.appendChild(dot);
      }

      // Crosshair layer.
      const cross = svg("line", { y1: m.top, y2: m.top + ih, className: "crosshair" });
      const hoverDots = svg("g", {});
      const overlay = svg("rect", { x: m.left, y: m.top, width: iw, height: ih, className: "hit" });
      root.appendChild(cross);
      root.appendChild(hoverDots);
      root.appendChild(overlay);
      const nearest = (pts, t) => {
        let best = null;
        for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        return best;
      };
      overlay.addEventListener("mousemove", (e) => {
        const box = root.getBoundingClientRect();
        const t = t0 + ((e.clientX - box.left - m.left) / iw) * span;
        clear(hoverDots);
        const rows = [];
        let snapT = null;
        for (const s of opts.series) {
          const p = nearest(s.points, t);
          if (!p) continue;
          if (snapT == null) snapT = p.t;
          const c = svg("circle", { cx: x(p.t), cy: y(p.v), r: 4, className: "dot" });
          c.style.fill = s.color;
          hoverDots.appendChild(c);
          rows.push({ label: s.label, value: yFormat(p.v), color: s.color });
        }
        if (snapT == null) return;
        cross.setAttribute("x1", x(snapT));
        cross.setAttribute("x2", x(snapT));
        cross.classList.add("visible");
        const mk = (opts.markers || []).find((mm) => Math.abs(mm.t - snapT) < span / 80);
        showTooltip(
          e,
          opts.tooltipTitle ? opts.tooltipTitle(snapT) : fmt.dateTime(snapT),
          rows,
          mk ? mk.label : null,
        );
      });
      overlay.addEventListener("mouseleave", () => {
        cross.classList.remove("visible");
        clear(hoverDots);
        hideTooltip();
      });
      return root;
    });
  }

  // ── Heatmap (sequential, one hue) ──────────────────────────────────────
  /**
   * opts: { rows: [label], cols: [label], values: number[][], format,
   *         title(r, c) → string, extraRows(r, c) → rows, colTick(c) → string|null }
   */
  function heatmap(opts) {
    const rowsN = opts.rows.length;
    const colsN = opts.cols.length;
    const cellH = 16;
    const height = rowsN * (cellH + 2) + 22;
    const max = Math.max(0, ...opts.values.flat());
    const STEPS = 6;
    const level = (v) =>
      v <= 0 || max <= 0 ? 0 : Math.min(STEPS, 1 + Math.floor((v / max) * (STEPS - 0.0001)));
    const host = responsive(height, (width) => {
      const left = 32;
      const cw = Math.max(4, (width - left) / colsN - 2);
      const root = svg("svg", { width, height, className: "chart heatmap", role: "img" });
      opts.rows.forEach((label, r) => {
        root.appendChild(
          svg(
            "text",
            {
              x: left - 6,
              y: r * (cellH + 2) + cellH - 4,
              className: "tick",
              "text-anchor": "end",
            },
            label,
          ),
        );
        opts.cols.forEach((_, c) => {
          const v = opts.values[r][c];
          const cell = svg("rect", {
            x: left + c * (cw + 2),
            y: r * (cellH + 2),
            width: cw,
            height: cellH,
            rx: 2,
            className: "cell q" + level(v),
            tabindex: v > 0 ? 0 : null,
          });
          hoverTip(cell, () => [
            opts.title(r, c),
            [
              { label: "Tokens", value: opts.format(v) },
              ...(opts.extraRows ? opts.extraRows(r, c) : []),
            ],
            null,
          ]);
          root.appendChild(cell);
        });
      });
      opts.cols.forEach((_, c) => {
        const tick = opts.colTick ? opts.colTick(c) : null;
        if (tick)
          root.appendChild(
            svg(
              "text",
              {
                x: left + c * (cw + 2) + cw / 2,
                y: height - 5,
                className: "tick",
                "text-anchor": "middle",
              },
              tick,
            ),
          );
      });
      return root;
    });
    const scale = el(
      "div",
      { className: "heat-scale" },
      el("span", {}, "Less"),
      ...Array.from({ length: STEPS + 1 }, (_, i) =>
        el("span", { className: "heat-swatch q" + i }),
      ),
      el("span", {}, "More"),
      max > 0
        ? el("span", { className: "muted" }, " · max " + opts.format(max) + " per hour")
        : null,
    );
    return el("div", {}, host, scale);
  }

  // ── Scatter ────────────────────────────────────────────────────────────
  /**
   * opts: { points: [{ x, y, series, title, rows }], series, xLabel, yLabel,
   *         xFormat, yFormat, logX, logY, height }
   */
  function scatter(opts) {
    const height = opts.height || 200;
    return responsive(height, (width) => {
      const m = { top: 10, right: 12, bottom: 32, left: 44 };
      const iw = width - m.left - m.right;
      const ih = height - m.top - m.bottom;
      const tf = (v, log) => (log ? Math.log10(Math.max(1, v)) : v);
      const xs = opts.points.map((p) => tf(p.x, opts.logX));
      const ys = opts.points.map((p) => tf(p.y, opts.logY));
      const xMin = opts.logX ? Math.floor(Math.min(...xs, 0)) : 0;
      const yMin = opts.logY ? Math.floor(Math.min(...ys, 0)) : 0;
      const xMax = opts.logX
        ? Math.ceil(Math.max(...xs, 1))
        : niceTicks(Math.max(...xs, 1), 4).slice(-1)[0];
      const yMax = opts.logY
        ? Math.ceil(Math.max(...ys, 1))
        : niceTicks(Math.max(...ys, 1), 4).slice(-1)[0];
      const x = (v) => m.left + ((tf(v, opts.logX) - xMin) / Math.max(1e-9, xMax - xMin)) * iw;
      const y = (v) => m.top + ih - ((tf(v, opts.logY) - yMin) / Math.max(1e-9, yMax - yMin)) * ih;
      const root = svg("svg", { width, height, className: "chart", role: "img" });
      const yTicks = opts.logY
        ? Array.from({ length: yMax - yMin + 1 }, (_, i) => Math.pow(10, yMin + i))
        : niceTicks(yMax, 4);
      const xTicks = opts.logX
        ? Array.from({ length: xMax - xMin + 1 }, (_, i) => Math.pow(10, xMin + i))
        : niceTicks(xMax, 4);
      for (const t of yTicks) {
        root.appendChild(
          svg("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), className: "grid" }),
        );
        root.appendChild(
          svg(
            "text",
            { x: m.left - 6, y: y(t) + 3.5, className: "tick", "text-anchor": "end" },
            (opts.yFormat || fmt.compact)(t),
          ),
        );
      }
      for (const t of xTicks)
        root.appendChild(
          svg(
            "text",
            { x: x(t), y: m.top + ih + 14, className: "tick", "text-anchor": "middle" },
            (opts.xFormat || fmt.compact)(t),
          ),
        );
      root.appendChild(
        svg("line", {
          x1: m.left,
          x2: width - m.right,
          y1: m.top + ih,
          y2: m.top + ih,
          className: "axis",
        }),
      );
      root.appendChild(
        svg(
          "text",
          { x: m.left + iw / 2, y: height - 2, className: "axis-label", "text-anchor": "middle" },
          opts.xLabel,
        ),
      );
      root.appendChild(
        svg(
          "text",
          {
            x: 10,
            y: m.top + ih / 2,
            className: "axis-label",
            "text-anchor": "middle",
            transform: `rotate(-90 10 ${m.top + ih / 2})`,
          },
          opts.yLabel,
        ),
      );
      const color = Object.fromEntries(opts.series.map((s) => [s.key, s.color]));
      for (const p of opts.points) {
        const g = svg("g", { className: "scatter-pt", tabindex: 0 });
        const hit = svg("circle", { cx: x(p.x), cy: y(p.y), r: 9, className: "hit" });
        const c = svg("circle", { cx: x(p.x), cy: y(p.y), r: 4.5, className: "dot" });
        c.style.fill = color[p.series];
        g.appendChild(c);
        g.appendChild(hit);
        hoverTip(g, () => [p.title, p.rows, null]);
        root.appendChild(g);
      }
      return root;
    });
  }

  // ── Sparkline ──────────────────────────────────────────────────────────
  function sparkline(values, opts) {
    const w = (opts && opts.width) || 96;
    const h = (opts && opts.height) || 28;
    const root = svg("svg", { width: w, height: h, className: "sparkline", "aria-hidden": "true" });
    if (!values.length) return root;
    const max = Math.max(...values, 0) || 1;
    const bw = Math.max(1.5, w / values.length - 1.5);
    values.forEach((v, i) => {
      const bh = Math.max(1, (v / max) * (h - 2));
      const r = svg("rect", {
        x: i * (w / values.length),
        y: h - bh,
        width: bw,
        height: bh,
        rx: Math.min(1.5, bw / 2),
        className: i === values.length - 1 ? "spark-current" : "spark",
      });
      root.appendChild(r);
    });
    return root;
  }

  // ── HTML figures ───────────────────────────────────────────────────────

  /** Severity meter: fill carries state, the track is a lighter step of the same ramp. */
  function meter(used, opts) {
    const clamped = Math.max(0, Math.min(100, used));
    const sev = TW.severity(used);
    return el(
      "div",
      {
        className: "meter sev-" + sev.key + (opts && opts.thin ? " thin" : ""),
        role: "meter",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round(clamped),
        "aria-label": (opts && opts.label ? opts.label + ": " : "") + Math.round(used) + "% used",
      },
      el("div", { className: "meter-fill", style: { width: clamped + "%" } }),
    );
  }

  /**
   * items: [{ key, label, value, sub?, color?, action?: { label, onClick } }]
   */
  function rankedBars(items, opts) {
    const format = (opts && opts.format) || fmt.compact;
    const total = (opts && opts.total) ?? items.reduce((s, i) => s + (i.value || 0), 0);
    const max = Math.max(...items.map((i) => i.value || 0), 0) || 1;
    return el(
      "div",
      { className: "ranked" },
      items.map((it) => {
        const share = total > 0 ? (it.value || 0) / total : 0;
        const row = el(
          "div",
          { className: "ranked-row" + (it.muted ? " muted-row" : ""), tabindex: 0 },
          el(
            "div",
            { className: "ranked-head" },
            it.color ? el("span", { className: "swatch", style: { background: it.color } }) : null,
            el("span", { className: "ranked-label", title: it.label }, it.label),
            it.badge
              ? el(
                  "span",
                  { className: "pill pill-" + (it.badge.kind || "neutral") },
                  it.badge.label,
                )
              : null,
            el("span", { className: "ranked-value" }, it.valueText ?? format(it.value)),
            el("span", { className: "ranked-share" }, total > 0 ? fmt.pct(share) : ""),
          ),
          el(
            "div",
            { className: "ranked-track" },
            el("div", {
              className: "ranked-fill",
              style: {
                width: Math.max(it.value > 0 ? 1.5 : 0, ((it.value || 0) / max) * 100) + "%",
                background: it.color || "var(--s1)",
              },
            }),
          ),
          it.sub || it.action
            ? el(
                "div",
                { className: "ranked-sub" },
                it.sub ? el("span", {}, it.sub) : null,
                it.action
                  ? el(
                      "button",
                      { className: "link-btn", onClick: it.action.onClick },
                      it.action.label,
                    )
                  : null,
              )
            : null,
        );
        if (it.tip) hoverTip(row, it.tip);
        return row;
      }),
    );
  }

  /** Tall segmented bar (one whole, split into parts) + its legend. */
  function segmented(parts, opts) {
    const format = (opts && opts.format) || fmt.compact;
    const total = parts.reduce((s, p) => s + (p.value || 0), 0);
    const bar = el("div", {
      className: "segbar",
      role: "img",
      "aria-label": parts
        .map((p) => p.label + " " + fmt.pct(total ? p.value / total : 0))
        .join(", "),
    });
    for (const p of parts) {
      if (!(p.value > 0)) continue;
      const share = p.value / total;
      const seg = el("div", {
        className: "segbar-part",
        style: { flexGrow: String(p.value), background: p.color },
        tabindex: 0,
      });
      seg.dataset.label = fmt.pct(share);
      seg.dataset.ink = p.ink || "light";
      hoverTip(seg, () => [
        p.label,
        [
          { label: "Amount", value: format(p.value), color: p.color },
          { label: "Share", value: fmt.pct(share) },
        ],
        null,
      ]);
      bar.appendChild(seg);
    }
    // Only print a share inside a block when it fits (measured after layout).
    requestAnimationFrame(() => {
      for (const seg of bar.children) {
        const text = seg.dataset.label;
        if (seg.clientWidth >= text.length * 7 + 12) seg.textContent = text;
      }
    });
    return el("div", { className: "segbar-wrap" }, bar, legend(parts.filter((p) => p.value > 0)));
  }

  /**
   * Sortable table. columns: [{ key, label, numeric?, format?(v,row), sortValue?(row), className? }]
   */
  function table(columnsDef, rows, opts) {
    let sortKey = opts && opts.sortKey;
    let sortDir = (opts && opts.sortDir) || "desc";
    const wrap = el("div", { className: "table-wrap" });
    const render = () => {
      clear(wrap);
      const col = columnsDef.find((c) => c.key === sortKey);
      const sorted = col
        ? [...rows].sort((a, b) => {
            const av = col.sortValue ? col.sortValue(a) : a[col.key];
            const bv = col.sortValue ? col.sortValue(b) : b[col.key];
            const an = av == null ? -Infinity : av;
            const bn = bv == null ? -Infinity : bv;
            const cmp = typeof an === "string" ? an.localeCompare(bn) : an - bn;
            return sortDir === "asc" ? cmp : -cmp;
          })
        : rows;
      const limit = opts && opts.limit && !wrap.dataset.expanded ? opts.limit : Infinity;
      const t = el(
        "table",
        { className: "data-table" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            columnsDef.map((c) =>
              el(
                "th",
                {
                  className:
                    (c.numeric ? "num" : "") +
                    (c.key === sortKey ? " sorted" : "") +
                    (c.sortable === false ? "" : " sortable"),
                  onClick:
                    c.sortable === false
                      ? null
                      : () => {
                          if (sortKey === c.key) sortDir = sortDir === "desc" ? "asc" : "desc";
                          else {
                            sortKey = c.key;
                            sortDir = c.numeric ? "desc" : "asc";
                          }
                          render();
                        },
                  "aria-sort":
                    c.key === sortKey ? (sortDir === "asc" ? "ascending" : "descending") : null,
                },
                c.label,
                c.key === sortKey
                  ? el("span", { className: "sort-ind" }, sortDir === "asc" ? " ↑" : " ↓")
                  : null,
              ),
            ),
          ),
        ),
        el(
          "tbody",
          {},
          sorted.slice(0, limit).map((r) =>
            el(
              "tr",
              {
                className: opts && opts.rowClass ? opts.rowClass(r) : "",
                onClick: opts && opts.onRowClick ? () => opts.onRowClick(r) : null,
              },
              columnsDef.map((c) => {
                const v = c.format ? c.format(r[c.key], r) : r[c.key];
                return el(
                  "td",
                  {
                    className: (c.numeric ? "num" : "") + (c.className ? " " + c.className : ""),
                    title: c.title ? c.title(r) : null,
                  },
                  v == null ? TW.NA : v,
                );
              }),
            ),
          ),
        ),
      );
      wrap.appendChild(t);
      if (limit < sorted.length || wrap.dataset.expanded) {
        wrap.appendChild(
          el(
            "button",
            {
              className: "link-btn table-more",
              onClick: () => {
                if (wrap.dataset.expanded) delete wrap.dataset.expanded;
                else wrap.dataset.expanded = "1";
                render();
              },
            },
            wrap.dataset.expanded ? "Show fewer" : "Show all " + sorted.length + " rows",
          ),
        );
      }
    };
    render();
    return wrap;
  }

  TW.charts = {
    responsive,
    niceTicks,
    legend,
    columns,
    line,
    heatmap,
    scatter,
    sparkline,
    meter,
    rankedBars,
    segmented,
    table,
    moveTooltip,
  };
})();
