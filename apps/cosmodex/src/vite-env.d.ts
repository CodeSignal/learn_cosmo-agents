/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Same-origin path of the engine gateway, e.g. /engine/cosmodex */
  readonly VITE_ENGINE_PATH?: string
  /** The task workspace, shown as the project */
  readonly VITE_WORKSPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
