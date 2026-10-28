import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

// Served by the simulation under /agents/cosmo-code/, talking to /engine/cosmo-code.
export default defineConfig({
  base: process.env.COSMO_CODE_BASE ?? "/agents/cosmo-code/",
  plugins: [tailwindcss(), solid()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "import.meta.env.VITE_VERSION": JSON.stringify(version) },
  worker: { format: "es" },
  build: { target: "esnext", sourcemap: false },
})
