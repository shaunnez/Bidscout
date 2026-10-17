import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    proxy: { "/api": `http://127.0.0.1:${process.env.BIDSCOUT_API_PORT ?? 4328}` },
  },
});
