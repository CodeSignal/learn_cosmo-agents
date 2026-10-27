import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

// Served by the simulation under /agents/cosmodex/, talking to /engine/cosmodex.
export default defineConfig({
  base: process.env.COSMODEX_BASE ?? "/agents/cosmodex/",
  plugins: [tailwindcss(), solid()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  worker: { format: "es" },
  build: { target: "esnext", sourcemap: false },
})
