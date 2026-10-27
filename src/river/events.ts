// One fixed event vocabulary over river appends, and observe-only hooks. A hook is called after its row is recorded,
// gets a frozen copy, and cannot change the row or the turn. A hook that throws (or rejects) is reported to onError and
// skipped; the append and the other hooks go on. Observe outside the secret guard, so hooks only ever see scanned rows.

import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { River, RiverRow } from "../contracts.js";
import { purposeOf, type Purpose } from "./purpose.js";
import { createThreadHasher } from "./thread-key.js";

export type EventType =
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "tool.called"
  | "tool.result"
  | "tool.retry"
  | "wake.fired"
  | "wake.skipped"
  | "say"
  | `row.${string}`;

export type NatalisEvent = Readonly<{ type: EventType; seq: number; atMs: number; thread: string; purpose: Purpose; row: Readonly<RiverRow> }>;
export type Hook = (event: NatalisEvent) => void | Promise<void>;

export function eventTypeOf(row: Pick<RiverRow, "kind" | "data">): EventType {
  const data = row.data ?? {};
  switch (row.kind) {
    case "turn":
      if (data["phase"] === "start") return "turn.started";
      return data["endedBy"] === "model_error" ? "turn.failed" : "turn.completed";
    case "tool_call":
      return "tool.called";
    case "receipt":
      return "tool.result";
    case "say":
      return "say";
    case "note":
      if (data["retryOf"] !== undefined) return "tool.retry";
      if (data["wakeSkipped"] !== undefined) return "wake.skipped";
      return "row.note";
    case "event":
      return data["wakeId"] !== undefined ? "wake.fired" : "row.event";
    default:
      return `row.${row.kind}`;
  }
}

export type EventBus = {
  /** Subscribe to one type, or "*" for all. Returns the unsubscribe. */
  on(type: EventType | "*", hook: Hook): () => void;
  emit(event: NatalisEvent): void;
};

export function createEventBus(options: { onError: (message: string) => void }): EventBus {
  const hooks: Array<{ type: EventType | "*"; hook: Hook }> = [];
  const report = (err: unknown) => options.onError(`a hook failed: ${err instanceof Error ? err.message : String(err)}`);
  return {
    on(type, hook) {
      const entry = { type, hook };
      hooks.push(entry);
      return () => {
        const i = hooks.indexOf(entry);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
    emit(event) {
      for (const { type, hook } of [...hooks]) {
        if (type !== "*" && type !== event.type) continue;
        try {
          const result = hook(event);
          if (result instanceof Promise) result.catch(report);
        } catch (err) {
          report(err);
        }
      }
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/** A river whose appends are told to the bus after they are recorded. Reads and the rest pass straight through. */
export function observeRiver(river: River, bus: EventBus, purpose: Purpose): River {
  return {

    append(row) {
      const recorded = river.append(row);
      const copy = deepFreeze(structuredClone(recorded));
      const rowPurpose = purposeOf(copy);
      bus.emit(
        Object.freeze({
          type: eventTypeOf(copy),
          seq: copy.seq,
          atMs: copy.atMs,
          thread: copy.thread,
          purpose: rowPurpose === "live" ? purpose : rowPurpose,
          row: copy,
        }),
      );
      return recorded;
    },
    read: (query) => river.read(query),
    count: (query) => river.count(query),
    search: (text, options) => river.search(text, options),
    forget: (match, by, reason) => river.forget(match, by, reason),
    lastSeq: () => river.lastSeq(),
    close: () => river.close(),
  };
}

// MUST-FIX before the exporter is wired:
// 1. jsonlExporter must require an explicit dataDir (the Lar folder) instead of defaulting to the export file's folder.
// 2. thread-hash.key is deliberately NOT in the plain backup list (src/bin/commands/backup-format.ts PLAIN_FILES), so
//    a restore rotates the key and old exports stop joining; decide include-or-rotate then.
// 3. The rollback cleanup must delete thread-hash.key.

/** How the JSONL exporter treats thread names: left out, or given as a short keyed hash. */
export type JsonlExporterOptions = {
  threads?: "omit" | "hash";
  /** The Lar's data folder, where the thread hash key is kept. Defaults to the folder the export file is in. */
  dataDir?: string;
};

/** H-3: a hook that appends one JSON line per event: type, seq, time, purpose, and the thread only as a hash on request. Never text or data. */
export function jsonlExporter(path: string, options: JsonlExporterOptions = {}): Hook {
  // NIT-3: a thread name can carry a person's alias, so it is left out by default, or given as a short hash.
  // NIT-C: the hash is keyed to the Lar, so the same thread under another Lar's key gives another value.
  const hash = options.threads === "hash" ? createThreadHasher(options.dataDir ?? dirname(path)) : undefined;
  return (event) => {
    const thread = hash === undefined ? {} : { thread: hash(event.thread) };
    appendFileSync(path, JSON.stringify({ type: event.type, seq: event.seq, atMs: event.atMs, ...thread, purpose: event.purpose }) + "\n");
  };
}
