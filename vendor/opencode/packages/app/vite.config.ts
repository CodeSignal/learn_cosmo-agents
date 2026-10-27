import { defineConfig } from "vite"
import desktopPlugin from "./vite"

// OpenCosmo: served under a sub-path of the simulation server; no Sentry upload, no source maps.
export default defineConfig({
  base: process.env.OPENCOSMO_BASE ?? "/",
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: false,
  },
})
