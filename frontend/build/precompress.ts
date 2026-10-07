import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * Writes .br and .gz copies next to built scripts and styles. The console serves them by
 * Accept-Encoding; compressing at build time keeps request handling free of CPU work and
 * leaves media and API responses untouched.
 */
export function precompress(): Plugin {
  let outDir = "";
  return {
    name: "resolvate-precompress",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const assets = join(outDir, "assets");
      for (const name of readdirSync(assets)) {
        if (!/\.(?:js|css)$/.test(name)) continue;
        const source = readFileSync(join(assets, name));
        const brotli = brotliCompressSync(source, {
          params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
        });
        const gzip = gzipSync(source, { level: 9 });
        if (brotli.length < source.length) writeFileSync(join(assets, `${name}.br`), brotli);
        if (gzip.length < source.length) writeFileSync(join(assets, `${name}.gz`), gzip);
      }
    },
  };
}
