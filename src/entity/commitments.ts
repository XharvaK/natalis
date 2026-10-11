// The two notes about what a Lar stands for, both in its own notebook under self/. The household part is written by
// the summoner, through the body's commands. The Lar's own commitments are proposed by the Lar and agreed by the
// summoner; the body writes them when the summoner agrees. The Lar's notebook tools refuse both files, so each
// change goes through the one path that owns it. Everything here is mechanics: lines, paths and dates, no judgment.

export const HOUSEHOLD_PATH = "self/household.md";
export const COMMITMENTS_PATH = "self/constitution.md";

export const HOUSEHOLD_STUB = "# Household\n\nNothing is written here yet. Your summoner writes this part.\n";
export const COMMITMENTS_STUB =
  "# My commitments\n\nNothing is written here yet. What I come to stand for goes here: I propose it, my summoner " +
  "agrees, and it is kept with its date and reason.\n";
/** The commitments stub of the first releases. A file still holding exactly this text is replaced by COMMITMENTS_STUB. */
export const OLD_COMMITMENTS_STUB =
  "# Constitution\n\nNothing is written here yet. This is where what I hold to will go, in my own words.\n";

const PROTECTED: Readonly<Record<string, string>> = {
  [HOUSEHOLD_PATH]: "Your summoner writes your household part.",
  [COMMITMENTS_PATH]: "Your commitments change through propose_commitment.",
};

/**
 * The plain reason the Lar's notebook tools refuse a path, or undefined when the path is open to them. Folder
 * spelling and letter case do not count: on some hosts "SELF/Household.md" is the same file.
 */
export function protectedNoteReason(path: string): string | undefined {
  const key = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")
    .toLowerCase();
  return Object.hasOwn(PROTECTED, key) ? PROTECTED[key] : undefined;
}

/** True when a note is missing, empty, or still the stub it started with. */
export function isStub(note: string | null, stub: string): boolean {
  return note === null || note.trim() === "" || note.trim() === stub.trim();
}

function linesOf(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function isHouseholdItem(line: string): boolean {
  return line.startsWith("- ");
}

/** The household note with one more "- " line at the end. `count` is how many lines it now holds. */
export function withHouseholdLine(note: string | null, line: string): { text: string; count: number } {
  const base = note === null || isStub(note, HOUSEHOLD_STUB) ? "# Household\n\n" : `${note.replace(/\s+$/, "")}\n`;
  const text = `${base}- ${line}\n`;
  const count = linesOf(text).filter(isHouseholdItem).length;
  return { text, count };
}

/** The household note without its n-th "- " line (counted from 1), or undefined when there is no such line. */
export function withoutHouseholdLine(note: string | null, n: number): { text: string; removed: string } | undefined {
  const lines = linesOf(note ?? "");
  let seen = 0;
  let at = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!isHouseholdItem(lines[index] ?? "")) continue;
    seen += 1;
    if (seen === n) {
      at = index;
      break;
    }
  }
  if (at < 0) return undefined;
  const removed = (lines[at] ?? "").slice(2);
  const kept = lines.filter((_, index) => index !== at).join("\n").replace(/\n+$/, "");
  return { text: `${kept}\n`, removed };
}

/** The household note as the summoner reads it: each "- " line numbered, so it can be removed by number. */
export function householdForSummoner(note: string | null): string {
  let n = 0;
  return linesOf((note ?? HOUSEHOLD_STUB).trim())
    .map((line) => {
      if (!isHouseholdItem(line)) return line;
      n += 1;
      return `[${n}] ${line.slice(2)}`;
    })
    .join("\n");
}

/** One agreed commitment, as it is kept in the Lar's commitments note. */
export function commitmentBlock(item: { text: string; why: string }, proposedDay: string, agreedDay: string): string {
  return `- ${item.text}\n  (proposed ${proposedDay}, agreed by your summoner ${agreedDay}; why: ${item.why})`;
}

/** The commitments note with one more block at the end. The stub is replaced by a heading and the block. */
export function withCommitment(note: string | null, block: string): string {
  if (note === null || isStub(note, COMMITMENTS_STUB) || note.trim() === OLD_COMMITMENTS_STUB.trim()) {
    return `# My commitments\n\n${block}\n`;
  }
  return `${note.replace(/\s+$/, "")}\n\n${block}\n`;
}
