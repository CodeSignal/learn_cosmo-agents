// The connection to the engine, through the simulation's gateway on the same origin: method calls
// with POST /rpc, notifications and engine requests (approvals, questions) over SSE /events,
// answers with POST /respond. The gateway decides what may pass; refusals come back as errors
// with `data.blocked`.
/** The simulation's own routes (its page, APIs, engine gateways), apart from a task's app. */
export const COSMO: string = import.meta.env.VITE_COSMO ?? "/_cosmo"
const BASE = import.meta.env.VITE_ENGINE_PATH ?? `${COSMO}/engine/cosmodex`

export type EngineErrorBody = { code: number; message: string; data?: { blocked?: boolean } }

export class EngineError extends Error {
  readonly code: number
  readonly blocked: boolean
  constructor(body: EngineErrorBody) {
    super(body.message)
    this.code = body.code
    this.blocked = !!body.data?.blocked
  }
}

export async function call<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: EngineErrorBody }
  if (body.error) throw new EngineError(body.error)
  return body.result as T
}

export async function respond(id: string | number, result: unknown): Promise<void> {
  const res = await fetch(`${BASE}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, result }),
  })
  const body = (await res.json()) as { error?: EngineErrorBody }
  if (body.error) throw new EngineError(body.error)
}

/** A message from the engine: a notification, or a request the candidate answers (has an id). */
export type EngineMessage = { id?: string | number; method: string; params?: any }

/** Listen to the engine. EventSource reconnects by itself; the gateway replays open requests. */
export function listen(onMessage: (msg: EngineMessage) => void): () => void {
  const source = new EventSource(`${BASE}/events`)
  source.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data))
    } catch (error) {
      console.error("Unreadable engine message", error)
    }
  }
  return () => source.close()
}
