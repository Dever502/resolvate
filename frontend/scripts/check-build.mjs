// Static checks of the production build against the console CSP and the boot order.
// The browser tests check the same at runtime; this catches regressions without a browser.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../src/resolvate/console_dist/", import.meta.url));
const problems = [];
const html = readFileSync(`${OUT}index.html`, "utf8");

if (/<style[\s>]/i.test(html)) problems.push("index.html: <style> element");
if (/\sstyle\s*=/i.test(html)) problems.push("index.html: style attribute");
for (const [, attributes] of html.matchAll(/<script([^>]*)>/gi)) {
  if (!/\ssrc=/.test(attributes)) problems.push("index.html: inline <script>");
}
const theme = html.search(/<script src="\.\/assets\/theme-boot-[\w-]+\.js"><\/script>/);
const entry = html.indexOf('<script type="module"');
const stylesheet = html.indexOf('<link rel="stylesheet"');
if (theme < 0) problems.push("index.html: theme boot script missing");
else if (!(theme < entry && theme < stylesheet)) problems.push("index.html: theme boot must precede the stylesheet and the entry");

const manifest = JSON.parse(readFileSync(`${OUT}.vite/manifest.json`, "utf8"));
const main = manifest["index.html"];
if (!main?.isEntry) problems.push("manifest: no entry");
else if (main.imports?.length) problems.push(`entry statically imports ${main.imports.join(", ")}: the session check would wait`);

for (const name of readdirSync(`${OUT}assets`)) {
  if (name.endsWith(".br") || name.endsWith(".gz")) continue;
  const text = readFileSync(`${OUT}assets/${name}`, "utf8");
  if (name.endsWith(".css") && /url\(\s*["']?data:/i.test(text)) problems.push(`${name}: data: URL (blocked by CSP)`);
  if (name.endsWith(".js")) {
    if (/\beval\(|new Function\(/.test(text)) problems.push(`${name}: eval or new Function (blocked by CSP)`);
    if (/createElement\(["']style["']\)|\bas:\s*["']style["']/.test(text)) problems.push(`${name}: creates <style> (blocked by CSP)`);
  }
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log("build: CSP-safe markup and assets, theme boot first, entry without static imports");
