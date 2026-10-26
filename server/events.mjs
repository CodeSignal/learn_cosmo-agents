// Append-only event log for Cosmo: agent switches, blocked attempts, engine status.
// One JSON object per line in EVENTS_DIR/events.jsonl; run_solution.sh prints it.
import fs from "node:fs";
import path from "node:path";

export function createEventLog(dir) {
  let seq = 0;
  const file = dir ? path.join(dir, "events.jsonl") : null;
  const listeners = new Set();
  return {
    file,
    record(type, detail = {}) {
      const event = { seq: ++seq, at: new Date().toISOString(), type, ...detail };
      if (file) {
        try {
          fs.appendFileSync(file, JSON.stringify(event) + "\n");
        } catch (e) {
          console.error(`event log write failed: ${e.message}`);
        }
      }
      for (const fn of listeners) fn(event);
      return event;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
