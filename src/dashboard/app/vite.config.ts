import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"));

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  root: ".",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../../../dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:18791",
      "/ws": {
        target: "ws://localhost:18791",
        ws: true,
      },
    },
  },
});
