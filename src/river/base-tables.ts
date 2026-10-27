// The tables 061af27 owns, copied verbatim from the Auditor's AU_BASE_TABLES_natalis_061af27.md. The memory rollback
// (and U8's derived-store list) is checked against this one list: anything else in river.db is derived and is emptied
// before the old code starts. User_version must stay 1 (river.db) and 4 (domus.sqlite).

export const BASE_061AF27_RIVER_DB = [
  "rows", "rows_thread_seq", "rows_at_ms",
  "river_fts", "river_fts_data", "river_fts_idx", "river_fts_docsize", "river_fts_config", "river_fts_content",
  "turn_ledger", "call_ledger",
  "sqlite_sequence",
] as const; // river_fts* absent if built without FTS5; user_version must stay 1
export const BASE_061AF27_DOMUS_SQLITE = [
  "observations", "observations_thread", "observations_attachment",
  "acts", "acts_attachment_state", "act_events",
  "plan_steps", "plan_steps_attachment_state", "undos",
  "snapshots", "snapshots_thread_status", "game_attention",
  "looks", "look_asks", "overlay_lines",
  "memory_asks", "memory_asks_status", "lists",
  "catalog_asks", "catalog_asks_status", "list_marks", "catalog_seen", "work_watch",
  "sqlite_sequence",
] as const; // plus names matching /^sqlite_autoindex_<table>_\d+$/ for the tables above; user_version 4

/** SQLite's own tables that ANALYZE may add; they hold counts only and are allowed beside the base set. */
export const SQLITE_STAT_TABLES = ["sqlite_stat1", "sqlite_stat4"] as const;

/** True for a name 061af27 owns in river.db (indexes are listed too; the rollback checks tables only). */
export function isBaseRiverTable(name: string): boolean {
  return (BASE_061AF27_RIVER_DB as readonly string[]).includes(name);
}

const DOMUS_BASE: ReadonlySet<string> = new Set(BASE_061AF27_DOMUS_SQLITE);

/**
 * True for a name 061af27 owns in domus.sqlite: a listed table, or an auto-index SQLite made for one of them
 * (sqlite_autoindex_<table>_<n>). Indexes outside that pattern are not base.
 */
export function isBaseDomusTable(name: string): boolean {
  if (DOMUS_BASE.has(name)) return true;
  const match = /^sqlite_autoindex_(.+)_\d+$/.exec(name);
  return match !== null && DOMUS_BASE.has(match[1] ?? "");
}
