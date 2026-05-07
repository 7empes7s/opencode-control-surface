import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "~": "/app",
      "@server": "/server",
    },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      "/opencode": {
        target: "http://localhost:4096",
        rewrite: (path) => path.replace(/^\/opencode/, ""),
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3000,
    host: true,
    allowedHosts: ["control.techinsiderbytes.com", "localhost"],
  },
});