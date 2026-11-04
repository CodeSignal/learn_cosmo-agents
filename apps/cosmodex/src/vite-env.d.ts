/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The simulation's own routes, /_cosmo */
  readonly VITE_COSMO?: string
  /** Same-origin path of the engine gateway, e.g. /_cosmo/engine/cosmodex */
  readonly VITE_ENGINE_PATH?: string
  /** The task workspace, shown as the project */
  readonly VITE_WORKSPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
