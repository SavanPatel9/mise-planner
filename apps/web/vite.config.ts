import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const env = loadEnv(mode, repoRoot, "VITE_");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
