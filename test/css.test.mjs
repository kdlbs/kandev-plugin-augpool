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
