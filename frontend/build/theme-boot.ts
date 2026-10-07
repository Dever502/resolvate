import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SOURCE = fileURLToPath(new URL("../src/boot/theme-boot.js", import.meta.url));
const NAME = "theme-boot.js";

/**
 * Emits the theme bootstrap as a hashed classic script and puts it first in <head>.
 * It must block rendering (not a module) so the first frame already has the saved theme,
 * and it must be hashed so the immutable cache applies to it like to every other asset.
 */
export function themeBoot(): Plugin {
  return {
    name: "resolvate-theme-boot",
    buildStart() {
      this.emitFile({ type: "asset", name: NAME, source: readFileSync(SOURCE, "utf8") });
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const asset = Object.values(context.bundle ?? {}).find(
          (file) => file.type === "asset" && file.names.includes(NAME),
        );
        const src = asset ? `./${asset.fileName}` : "/src/boot/theme-boot.js";
        // After the meta tags, before the stylesheet and the entry module.
        const anchor = html.indexOf("<script type=\"module\"");
        if (anchor < 0) throw new Error("theme-boot: entry module script not found in index.html");
        return `${html.slice(0, anchor)}<script src="${src}"></script>\n    ${html.slice(anchor)}`;
      },
    },
  };
}
