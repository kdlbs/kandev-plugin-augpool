import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Augpool styles stay scoped, responsive, and motion-safe", async () => {
  const css = await readFile(new URL("../ui/plugin.css", import.meta.url), "utf8");
  const selectors = css
    .split("{")
    .slice(0, -1)
    .map((part) => part.split("}").at(-1).trim())
    .filter((selector) => selector && !selector.startsWith("@"));

  assert.equal(selectors.every((selector) => selector.includes(".kandev-augpool")), true);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /min-height:\s*40px/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /transition:\s*(?:transform|background-color|border-color|color)/);
  assert.doesNotMatch(css, /transition:\s*all/i);
  assert.match(css, /transform:\s*scale\(0\.96\)/);
});

test("desktop table cells use a comfortable shared horizontal inset", async () => {
  const css = await readFile(new URL("../ui/plugin.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.kandev-augpool__table-wrap th,\s*\.kandev-augpool__table-wrap td\s*{[^}]*padding-inline:\s*16px/,
  );
});

test("settings health card fills the host settings column", async () => {
  const css = await readFile(new URL("../ui/plugin.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.kandev-augpool__settings-health\s*{[^}]*max-width:\s*none;[^}]*margin-inline:\s*0;/,
  );
});

test("dialog hit-area styles leave switches and checkboxes at native size", async () => {
  const css = await readFile(new URL("../ui/plugin.css", import.meta.url), "utf8");

  assert.doesNotMatch(css, /\.kandev-augpool__dialog-form button/);
  assert.match(css, /\.kandev-augpool__dialog-action/);
});

test("usage graphs use a quiet responsive two-to-one layout", async () => {
  const css = await readFile(new URL("../ui/plugin.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.kandev-augpool__graphs\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s+minmax\(280px,\s*1fr\);/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*1080px\)[\s\S]*?\.kandev-augpool__graphs\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
  );
  assert.match(
    css,
    /\.kandev-augpool__graph-card\s*{[^}]*box-shadow:\s*0\s+1px\s+2px[^;]*,[^;]*0\s+8px\s+24px/,
  );
});

test("chart marks use host theme colors and tabular values", async () => {
  const css = await readFile(new URL("../ui/plugin.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.kandev-augpool__session-segment\s*{[^}]*background:\s*var\(--session-color,\s*var\(--primary\)\)/,
  );
  assert.match(
    css,
    /\.kandev-augpool__session-legend strong\s*{[^}]*font-variant-numeric:\s*tabular-nums/,
  );
  assert.match(
    css,
    /\.kandev-augpool__day-label--end\s*{[^}]*text-align:\s*right/,
  );
  assert.match(css, /\.kandev-augpool__credit-fill\s*{[^}]*background:\s*var\(--primary\)/);
  assert.match(css, /\.kandev-augpool__credit-target\s*{[^}]*background:\s*var\(--foreground\)/);
  assert.match(
    css,
    /\.kandev-augpool__credit-label strong,[\s\S]*?\.kandev-augpool__graph-heading > span\s*{[^}]*font-variant-numeric:\s*tabular-nums/,
  );
});
