import { defineConfig } from "vite";
import { CONFIG } from "./src/config.ts";

// /api goes to the Node server in server/, which holds the Meta API key.
export default defineConfig({
  server: {
    proxy: { "/api": `http://127.0.0.1:${CONFIG.server.port}` },
  },
  // The hand worker is a module worker in dev, so build it as one too: MediaPipe then
  // loads its ES module wasm loader the same way in both.
  worker: { format: "es" },
});
