// The lockfile must install on both the CI runner (glibc) and the Docker build stage (Alpine, musl),
// and must only point at the public npm registry.
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const keys = Object.keys(lock.packages ?? {});
const problems = [];

if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion ${lock.lockfileVersion}, expected 3`);
for (const family of ["@rolldown/binding", "@tailwindcss/oxide", "lightningcss"]) {
  for (const libc of ["gnu", "musl"]) {
    const name = `node_modules/${family}-linux-x64-${libc}`;
    if (!keys.includes(name)) problems.push(`missing ${name}`);
  }
}
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (entry.resolved && !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    problems.push(`${key} resolves outside registry.npmjs.org: ${entry.resolved}`);
  }
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`lockfile: ${keys.length - 1} packages, glibc and musl binaries present`);
