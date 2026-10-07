// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Measured in Chromium, Firefox and WebKit under the console CSP (style-src 'self'):
// static style attributes may be compiled into HTML strings and are then blocked,
// while object :style bindings are applied through CSSOM.
const ROOT = fileURLToPath(new URL(".", import.meta.url));

function components(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? components(join(directory, entry.name))
      : entry.name.endsWith(".vue") ? [join(directory, entry.name)] : [],
  );
}

describe("component templates", () => {
  const files = components(ROOT);

  it("exist", () => expect(files.length).toBeGreaterThan(0));

  it.each(files.map((file) => [file.slice(ROOT.length)]))("%s stays within the console CSP", (name) => {
    const source = readFileSync(join(ROOT, name), "utf8");
    expect(source, "static style attribute").not.toMatch(/\sstyle\s*=/);
    expect(source, "string :style binding").not.toMatch(/(?::style|v-bind:style)\s*=\s*"\s*['`]/);
    expect(source, "v-html").not.toMatch(/\bv-html\b/);
    expect(source, "<style> block").not.toMatch(/<style[\s>]/);
  });
});
