/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Same-origin path of the engine gateway, e.g. /engine/cosmo-code */
  readonly VITE_ENGINE_PATH?: string
  /** The task workspace, shown as the project */
  readonly VITE_WORKSPACE?: string
  /** The app's version (package.json), set at build time. */
  readonly VITE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
