import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// The renderer helpers are a classic script that hangs off `window.TW`; it touches
// the DOM only when its functions run, so it loads in a bare VM context.
function loadRendererCore(): { fmt: { compact: (n: number | null) => string } } {
  const source = readFileSync(
    fileURLToPath(new URL("../src/gui/renderer/lib/core.js", import.meta.url)),
    "utf8",
  );
  const window: Record<string, unknown> = {};
  vm.runInNewContext(source, { window });
  return window.TW as { fmt: { compact: (n: number | null) => string } };
}

describe("renderer compact number format", () => {
  const { fmt } = loadRendererCore();

  it("keeps significant zeros in whole numbers", () => {
    // Regression: a trailing-zero trim once turned 300M into "3M" on chart axes.
    expect(fmt.compact(300e6)).toBe("300M");
    expect(fmt.compact(100e3)).toBe("100K");
    expect(fmt.compact(20e9)).toBe("20B");
    expect(fmt.compact(10e6)).toBe("10M");
  });

  it("trims only zeros after the decimal point", () => {
    expect(fmt.compact(2.5e6)).toBe("2.5M");
    expect(fmt.compact(3e6)).toBe("3M");
    expect(fmt.compact(1.06e9)).toBe("1.06B");
    expect(fmt.compact(12.5e3)).toBe("12.5K");
    expect(fmt.compact(-2.5e6)).toBe("-2.5M");
  });

  it("promotes to the next unit when rounding reaches 1000", () => {
    expect(fmt.compact(999_600)).toBe("1M");
    expect(fmt.compact(999_600_000)).toBe("1B");
    expect(fmt.compact(999.7)).toBe("1K");
  });

  it("formats small and missing values", () => {
    expect(fmt.compact(0)).toBe("0");
    expect(fmt.compact(950)).toBe("950");
    expect(fmt.compact(null)).toBe("n/a");
  });
});
