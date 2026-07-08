import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite config — three independent rollup pipelines:
 *   - main:     Node ESM, Electron app entry point
 *   - preload:  CJS, runs in the bridged context between main and renderer
 *   - renderer: ESM React app served via Vite dev server in dev mode
 *
 * The `@shared` alias points to the contract layer used by all three.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
    build: {
      outDir: "out/main",
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
    build: {
      outDir: "out/preload",
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
  },
});
