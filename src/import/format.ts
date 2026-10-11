// The plan as plain text, for the terminal. Short lines, no values from refused items: only file and line.

import type { ImportPlan, PlannedFile } from "./plan.js";

export function renderPlan(plan: ImportPlan): string[] {
  const lines: string[] = [];
  lines.push(`Bundle: ${plan.source} (created ${plan.createdAt})`);
  lines.push(
    `Entity folder: ${plan.target.dirExists ? "exists" : "will be created"}; river ${
      plan.target.riverExists ? `holds ${plan.target.riverLastSeq} rows` : "is new"
    }; notebook ${plan.target.notebookExists ? `holds ${plan.target.notebookFiles.length} files` : "is new"}`,
  );
  if (!plan.target.hasConfig) lines.push("Note: there is no entity.json yet. Add one before starting the entity.");

  lines.push("");
  lines.push(`Notebook files: ${plan.notes.length}`);
  for (const file of plan.notes) lines.push(fileLine(file));
  if (plan.provenance.length > 0) {
    lines.push(`Provenance files (notebook provenance/): ${plan.provenance.length}`);
    for (const file of plan.provenance) lines.push(fileLine(file));
  }

  lines.push("");
  lines.push(`River rows to write: ${plan.rows.written} (months in UTC)`);
  for (const entry of plan.rows.byMonth) lines.push(`  ${entry.key}: ${entry.count}`);
  for (const entry of plan.rows.byKindSource) lines.push(`  ${entry.key}: ${entry.count}`);
  lines.push(`Tombstones to write: ${plan.tombstones.written}`);
  lines.push(`Forgotten list: notebook forgotten.md`);
  lines.push(`Then: state.json, so the entity starts calm (no open asks, no wakes, no turns).`);

  if (plan.refused.length > 0) {
    lines.push("");
    lines.push(
      plan.skipRefused
        ? `Refused, left out (${plan.refused.length}):`
        : `Refused, not written (${plan.refused.length}):`,
    );
    for (const item of plan.refused) {
      const where = item.line === undefined ? item.file : `${item.file} line ${item.line}`;
      lines.push(`  ${where}: ${item.item}; ${item.reason}`);
    }
  }
  if (plan.conflicts.length > 0) {
    lines.push("");
    lines.push(`Conflicts (${plan.conflicts.length}):`);
    for (const conflict of plan.conflicts) lines.push(`  ${conflict}`);
  }
  return lines;
}

function fileLine(file: PlannedFile): string {
  const action = file.action === "new" ? "new     " : "replaces";
  const flag = file.refused ? "  REFUSED" : "";
  return `  ${action} ${file.path} (${formatBytes(file.bytes)})${flag}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
