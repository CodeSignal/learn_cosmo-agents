import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

// Served by the simulation under /agents/cosmo-code/, talking to /engine/cosmo-code.
export default defineConfig({
  base: process.env.COSMO_CODE_BASE ?? "/agents/cosmo-code/",
  plugins: [tailwindcss(), solid()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  worker: { format: "es" },
  build: { target: "esnext", sourcemap: false },
})
