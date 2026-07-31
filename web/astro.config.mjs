import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

export default defineConfig({
  site: process.env.SITE_URL ?? "http://localhost:4321",
  integrations: [react()],
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        buffer: "buffer/",
      },
    },
    optimizeDeps: {
      include: ["buffer", "@hashgraph/hedera-wallet-connect", "@walletconnect/modal"],
      esbuildOptions: {
        define: {
          global: "globalThis",
        },
      },
    },
    server: {
      proxy: {
        "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4021",
        "/catalog": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4021",
        "/data": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4021",
      },
    },
  },
});
