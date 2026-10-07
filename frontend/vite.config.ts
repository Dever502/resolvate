import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { precompress } from "./build/precompress.ts";
import { themeBoot } from "./build/theme-boot.ts";

// Relative base: the same build is served at /console/next/ now and at /console/ after the switch.
export default defineConfig({
  base: "./",
  plugins: [vue(), tailwindcss(), themeBoot(), precompress()],
  build: {
    outDir: "../src/resolvate/console_next",
    emptyOutDir: true,
    // CSP has no data: or blob: sources; every asset must be a same-origin file.
    assetsInlineLimit: 0,
    manifest: true,
    license: { fileName: ".vite/license.json" },
    rolldownOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    // Development against a local backend on :8080. The console checks Origin on writes,
    // so the proxy presents the backend's own origin (CONSOLE_ORIGIN=http://localhost:8080).
    proxy: {
      "^/console/(?!next/)": {
        target: "http://localhost:8080",
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.setHeader("origin", "http://localhost:8080"));
        },
      },
    },
  },
});
