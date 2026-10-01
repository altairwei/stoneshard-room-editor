import { defineConfig } from "vite";
import { svreApi } from "./server/api";

export default defineConfig({
  plugins: [svreApi(import.meta.dirname)],
  server: { port: 5178, strictPort: true },
  // "/assets/" is the extracted vanilla art cache route (server/api.ts) -- the bundle's
  // own chunks must live somewhere else or the prod static server 404s them
  build: { assetsDir: "bundle" },
});
