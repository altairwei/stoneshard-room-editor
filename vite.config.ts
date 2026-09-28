import { defineConfig } from "vite";
import { svreApi } from "./server/api";

export default defineConfig({
  plugins: [svreApi(import.meta.dirname)],
  server: { port: 5178, strictPort: true },
});
