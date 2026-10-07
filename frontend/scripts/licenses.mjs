// License gate for the bundled code and the notices file shipped with the build.
// Policy mirrors scripts/check_licenses.py: no GPL, AGPL or SSPL in what is distributed
// (LGPL is allowed); every bundled package must declare its license.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../src/resolvate/console_dist/", import.meta.url));
const packages = JSON.parse(readFileSync(`${OUT}.vite/license.json`, "utf8"));

const FORBIDDEN = /(^|[^L])GPL|SSPL/i;
const problems = packages.filter((item) => !item.identifier || FORBIDDEN.test(item.identifier));
if (problems.length) {
  for (const item of problems) console.error(`forbidden or missing license: ${item.name}@${item.version} (${item.identifier ?? "none"})`);
  process.exit(1);
}

const notices = packages
  .toSorted((a, b) => a.name.localeCompare(b.name))
  .map((item) => `${item.name} ${item.version} — ${item.identifier}\n\n${item.text ?? ""}`.trimEnd());
writeFileSync(
  `${OUT}third_party_licenses.txt`,
  `Third-party software bundled in the Resolvate operator console\n\n${notices.join("\n\n---\n\n")}\n`,
);
console.log(`licenses: ${packages.length} bundled packages, all allowed`);
