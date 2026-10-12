// The option table of a game view: what the game offers the Lar to do, each act with a short ref (a1, a2 ...)
// the Lar names. The world reads the table from the stored view and renders it as plain words. It never picks
// an option, ranks anything or says what the Lar should do.

import type { Found, OptionObject, AnswerRules } from "./answers.js";
import { answerRulesOf } from "./answers.js";
import type { OptionsCut, Percept } from "./wire.js";
import { type AttachmentNow, bodyLines, clockLine, needFeeling, needGradeOfBand, needGradeOfValue } from "./body.js";
import { DAY_BRIEF_LINE, dayRecordLines } from "./day-record.js";
import { capitalised, dropTokens, ORIGIN_WORDS, plainName, textOrUndefined, withStop } from "./words.js";

/** The longest the rendered view may be, in characters. The rest is said as a count. */
export const VIEW_TEXT_MAX = 20_000;
/** The longest an older view's brief may be, in characters. The rest is said as a count. */
export const BRIEF_MAX = 1_000;
/** The helper's id and where for her queue (its acts are the ones she has queued). */
const QUEUE_OBJECT_ID = "queue:her";
const QUEUE_WHERE = "your queue";
/** The words the view keeps for the end of the choices: the count line and the game's "more to come" line. */
const CHOICES_MORE = "More of the game's choices are still coming; these are the ones near you.";
/** The room of an object whose room the game did not name, in the view's headings. */
const OTHER_ROOMS = "Other rooms";

/** The options of a stored view, exactly as the helper sent them; anything malformed offers nothing. */
export function optionsOf(options: unknown): OptionObject[] {
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is OptionObject => !!item && typeof item === "object"
    && typeof (item as Record<string, unknown>).object === "string"
    && typeof (item as Record<string, unknown>).object_id === "string"
    && Array.isArray((item as Record<string, unknown>).acts));
}

/** Every ref in a table, in the order the game listed them. */
export function refsOf(options: readonly OptionObject[]): string[] {
  const refs: string[] = [];
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && typeof act.ref === "string" && typeof act.guid64 === "string" && typeof act.text === "string") {
        refs.push(act.ref);
      }
    }
  }
  return refs;
}

/** The act with this ref and its object, or null. A ref is only ever matched exactly. */
export function findOption(options: readonly OptionObject[], ref: string): Found | null {
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && act.ref === ref && typeof act.guid64 === "string" && typeof act.text === "string") {
        return { object, act };
      }
    }
  }
  return null;
}

/** The label an act is known by in the notebook and in the events it produces: its words and its object. */
export function labelOf(found: Found): string {
  return `${found.act.text} (${found.object.object})`.slice(0, 200);
}

function describeRules(rules: AnswerRules): string {
  const parts: string[] = [];
  if (rules.select) {
    parts.push(`pick ${rules.select.min} to ${rules.select.max === 0 ? "any number of" : rules.select.max} ${rules.select.max === 1 ? "row" : "rows"}`);
  }
  if (rules.counts) {
    parts.push(`up to ${rules.counts.max_in_row} of one row, at most ${rules.counts.max_rows} ${rules.counts.max_rows === 1 ? "row" : "rows"}`);
  }
  for (const field of rules.text ?? []) {
    const bounds = field.max_length === null ? `at least ${field.min_length}` : `${field.min_length} to ${field.max_length}`;
    const numeric = field.numeric ? `, a whole number from ${field.min_value ?? "?"} to ${field.max_value ?? "?"}` : "";
    parts.push(`type "${field.name}" (${field.label}), ${bounds} characters${numeric}`);
  }
  return parts.length ? parts.join("; ") : "none";
}

/** A text the game sent, trimmed; anything that is not text, or is empty, is undefined. */
function said(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = dropTokens(value);
  return text === "" ? undefined : text;
}

/** A text the game sent as one sentence: a full stop is added only when it has none of its own. */
function sentence(value: unknown): string | undefined {
  const text = said(value);
  return text === undefined ? undefined : /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A number the game sent, as a number or as a string of digits (the helper sends some values as text); else undefined. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * The words of a life-line record, one plain sentence per class (VOICE3-4, VIEW3-5). A save that only continues her life
 * says nothing. A death is named, with the game's cause when it is known. Undefined when there is nothing to say.
 */
export function lineageSentence(lineage: string | undefined, reason: string | undefined, deathType: string | undefined): string | undefined {
  if (lineage === undefined) return undefined;
  if (lineage === "BODY_GONE") {
    const cause = deathType === undefined ? "" : ` The game gives the cause as ${plainName(deathType)}.`;
    return reason === "GHOST"
      ? `You died in the game, and you are a ghost now.${cause}`
      : `You died in the game.${cause}`;
  }
  if (lineage === "CONTINUES_LAST_SAVE" || lineage === "PENDING") return undefined;
  if (lineage === "ROLLBACK") return "The game went back to an earlier save.";
  if (lineage === "UNOBSERVED_SAVE") return "The game saved without the link to the game seeing it.";
  if (lineage === "FORK") return "A second save was started from the one you were in.";
  if (lineage === "LINEAGE_TRANSFER") return "You are now in a different save from the one you had.";
  if (lineage === "FOREIGN_OR_UNKNOWN") return "The game is in a save the link to the game does not know.";
  if (lineage === "BODY_MISMATCH") return "The save the game is in does not match your body.";
  if (lineage.startsWith("READ_FAILURE")) return "The link to the game could not read the save.";
  return "The game's save changed.";
}

/**
 * One percept as one plain sentence, from its fixed form. Returns undefined for a kind it does not know, or a
 * percept missing what its sentence needs; such a percept has no line, and its raw facts are not shown to her.
 */
export function perceptSentence(percept: Percept): string | undefined {
  const facts = percept.facts;
  switch (percept.kind) {
    case "phone": {
      // W13: a notice on her phone (about a phone act of hers, when the game names it), or a call held for her, by the
      // name of the caller (the game's name, never a guess).
      const what = textOrUndefined(facts.what);
      if (what === "notice") {
        const act = textOrUndefined(facts.act);
        return `Your phone shows a new notification.${act ? ` It is about: ${act}.` : ""}`;
      }
      if (what === "call") return `${textOrUndefined(facts.from) ?? "Someone"} is calling you.`;
      return undefined;
    }
    case "need": {
      // N4: a need reaches her as its feeling, graded by its value when the game gives one, else by its band. A need that
      // is not felt (ok) has no words, so the view does not show it.
      const subject = textOrUndefined(facts.subject);
      if (!subject) return undefined;
      const value = numberOf(facts.value);
      const grade = value !== undefined ? needGradeOfValue(value) : needGradeOfBand(textOrUndefined(facts.band));
      return grade === undefined ? undefined : needFeeling(subject, grade);
    }
    case "moodlet": {
      const to = textOrUndefined(facts.to);
      if (!to) return undefined;
      const from = textOrUndefined(facts.from);
      const mood = (text: string) => plainName(text.replace(/^Mood_/, ""));
      return `Mood: ${mood(to)} now${from ? ` (was ${mood(from)})` : ""}.`;
    }
    case "interaction": {
      // VIEW3-4, VOICE2-2, VOICE3-5: one plain sentence per bucket. The game's codes and detail words stay in the logs;
      // with no act name the sentence says "your act" or "an act", never the bucket as its own name.
      const bucket = textOrUndefined(facts.bucket);
      const affordance = textOrUndefined(facts.affordance_text) ?? textOrUndefined(facts.tuning_name);
      const name = affordance ? plainName(affordance) : undefined;
      const origin = textOrUndefined(facts.origin);
      const from = origin ? ORIGIN_WORDS[origin] : undefined;
      const mine = from === "your act";
      const who = name ?? (mine ? "your act" : "an act");
      const cause = from && !mine ? ` (${from})` : "";
      if (bucket === "idle") return "You are idle.";
      if (bucket === "started" || bucket === "ended") {
        const verb = bucket === "started" ? "started" : "ended";
        return name ? `${capitalised(name)} ${verb}${from ? ` (${from})` : ""}.` : `${capitalised(who)} ${verb}${cause}.`;
      }
      if (bucket === "act_rejected") return `The game refused ${who}.`;
      if (bucket === "act_unknown") return `It is not known what became of ${who}.`;
      if (bucket === "act_never_started") return name ? `${capitalised(name)} never started.` : "Your act never started.";
      return undefined;
    }
    case "presence": {
      const bucket = textOrUndefined(facts.bucket);
      if (!bucket) return undefined;
      const verb = bucket === "arrived" ? "arrived" : bucket === "left" ? "left" : bucket === "on_lot" ? "is on the lot" : undefined;
      if (!verb) return undefined;
      const name = textOrUndefined(facts.name) ?? "Someone";
      const metres = Number(textOrUndefined(facts.distance_m));
      const parts = [
        Number.isFinite(metres) && textOrUndefined(facts.distance_m) !== undefined ? `${Math.round(metres)} m away` : undefined,
        textOrUndefined(facts.doing) ? plainName(textOrUndefined(facts.doing)!) : undefined,
      ].filter((part): part is string => part !== undefined);
      const role = textOrUndefined(facts.role);
      return `${name} ${verb}${parts.length ? `, ${parts.join(", ")}` : ""}${role ? ` (${role})` : ""}.`;
    }
    case "posture": {
      const posture = textOrUndefined(facts.bucket);
      return posture ? `Posture: ${plainName(posture)}.` : undefined;
    }
    case "social": {
      // SS4-v3: the helper's sentence for what was said to her; without one, who is talking to her and the act.
      // A number is never shown: an id the helper did not name is "Someone".
      const text = sentence(facts.sentence);
      if (text !== undefined) return text;
      const by = textOrUndefined(facts.by);
      const who = by === undefined || /^\d+$/.test(by) ? "Someone" : capitalised(by);
      const interaction = textOrUndefined(facts.interaction);
      return interaction ? `${who} is talking to you (${plainName(interaction)}).` : `${who} is talking to you.`;
    }
    case "env":
      return facts.from_room !== undefined ? "You moved rooms." : undefined;
    case "sleep_onset":
      return "You fell asleep.";
    case "lineage":
      return lineageSentence(textOrUndefined(facts.bucket), textOrUndefined(facts.reason), textOrUndefined(facts.death_type));
    case "notice": {
      const text = sentence(facts.text);
      const title = facts.title === undefined ? "" : said(facts.title);
      if (text === undefined || title === undefined) return undefined;
      return `The game says: ${title ? `${title}: ` : ""}${text}`;
    }
    case "self":
      return sentence(facts.text);
    case "look":
      return "This is the look you asked for.";
    case "gap":
      return "Part of the game's feed was missed.";
    default:
      return undefined;
  }
}

/**
 * One percept's line in a view: its plain sentence. A percept with no words (a kind it does not know, or one missing
 * what its sentence needs) has no line: its raw "kind: facts" text is not shown to her.
 */
export function perceptLine(percept: Percept): string | undefined {
  const sentence = perceptSentence(percept);
  return sentence === undefined ? undefined : `- ${sentence}`;
}

/**
 * The brief of an older view, kept in its row: the percept lines only, in the words the view shows them, and one line
 * when the view carried the game's record of the day. No body and no choices. "An earlier view." when there is neither.
 */
export function viewBrief(percepts: readonly Percept[], dayRecord = false): string {
  if (percepts.length === 0 && !dayRecord) return "An earlier view.";
  const all = percepts.map(perceptLine).filter((line): line is string => line !== undefined);
  const lines: string[] = [];
  let used = 0;
  for (const line of all) {
    if (used + line.length > BRIEF_MAX) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length < all.length) lines.push(`- (${all.length - lines.length} more not shown)`);
  if (dayRecord) lines.push(DAY_BRIEF_LINE);
  return lines.length === 0 ? "An earlier view." : lines.join("\n");
}

/**
 * The plain text of a game view for the Lar: what the game shows, then the choices it offers, each with its ref.
 * Shows the ref and the game's words only; no id, no matcher hint, no advice.
 */
export function renderView(input: {
  percepts: readonly Percept[]; options: readonly OptionObject[]; portrait?: unknown; attachment?: AttachmentNow;
  /** Her attention, the first line of the body block (see attentionLine). */
  attention?: string;
  /** The count line of her lists (see listCountLine), shown after her money. */
  counts?: string;
  /** The game's record of the day, when the view carries one. Its section comes after the body block (see day-record.ts). */
  day?: unknown;
  optionsCut?: OptionsCut;
  /** True while the game has not sent its first whole choices this session: the view says they are still coming. */
  choicesPending?: boolean;
}): string {
  const body = withCountLine(bodyLines(input.portrait, input.attachment, input.attention), input.counts);
  const record = dayRecordLines(input.day);
  const head = [
    ...(body.length ? ["Your body now:", ...body, ""] : []),
    ...(record.length ? [...record, ""] : []),
    "The game shows:",
  ];
  const lines: string[] = [...head];
  // VIEW3-11: a percept that says what the body block already says is not said twice. The newest first (VIEW3-19).
  const bodyText = [...body, ...record].join("\n");
  const all = [...input.percepts]
    .sort((a, b) => b.salience - a.salience)
    .map(perceptSentence)
    .filter((sentence): sentence is string => sentence !== undefined && !bodyText.includes(sentence))
    .map((sentence) => `- ${sentence}`);
  // The whole view is capped (VIEW3-8). The choices take what the percepts leave: the near ones are kept whole, the
  // farthest objects are cut first and said as a count.
  const percepts = fitLines(all, VIEW_TEXT_MAX - used(head) - CHOICES_RESERVE);
  lines.push(...percepts.kept);
  if (percepts.cut > 0) lines.push(`- (${percepts.cut} more not shown)`);
  // Until the game's first whole menu of this session, its choices are not in yet. With none sent so far, the view says
  // so instead of a list; a near part of the menu that did come is shown as it is.
  if (input.options.length === 0) {
    lines.push("", input.choicesPending ? "The game has not sent its choices yet. They come with a later view." : "The game offers no choices in this view.");
    return lines.join("\n");
  }
  const choices = choicesBlock(input.options, input.optionsCut, VIEW_TEXT_MAX - used(lines) - TAIL_RESERVE);
  lines.push("", ...choices);
  if (input.choicesPending) lines.push(CHOICES_MORE);
  return lines.join("\n");
}

/** The room of the lines kept after the cap, and what it cut. */
function fitLines(all: readonly string[], budget: number): { kept: string[]; cut: number } {
  const kept: string[] = [];
  let spent = 0;
  for (const line of all) {
    if (spent + line.length + 1 > budget) break;
    kept.push(line);
    spent += line.length + 1;
  }
  return { kept, cut: all.length - kept.length };
}

/** The characters of a list of lines, each with its newline. */
function used(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/** Kept room for the choices and their heading, when the percepts are cut: the choices always have room to show. */
const CHOICES_RESERVE = 600;
/** Kept room after the choices: the count of cut things and the game's "more to come" line. */
const TAIL_RESERVE = 240;

/** The distance a where names ("elsewhere, 12.0 m"), in metres; an object with none sorts last. */
function distanceOf(object: OptionObject): number {
  const found = typeof object.where === "string" ? /, ([\d.]+) m$/.exec(object.where) : null;
  return found ? Number(found[1]) : Number.POSITIVE_INFINITY;
}

/**
 * The choices block: the heading, the near objects, her queue, then the rest by room. The rest is kept nearest first, and
 * what does not fit the budget is cut farthest first and said in one line (VIEW3-8, item 14). Every object keeps its
 * refs. The view's count line of the game's own cut is added to the count.
 */
function choicesBlock(options: readonly OptionObject[], cut: OptionsCut | undefined, budget: number): string[] {
  const near = options.filter(isNear);
  // Her queue is not in a room: it is its own group, right after the near objects, and never under a room heading.
  const queue = options.filter((object) => !isNear(object) && isQueue(object));
  const rest = options.filter((object) => !isNear(object) && !isQueue(object))
    .map((object, index) => ({ object, index }))
    .sort((a, b) => distanceOf(a.object) - distanceOf(b.object) || a.index - b.index)
    .map((item) => item.object);
  const block = (kept: readonly OptionObject[]) => {
    const out: string[] = ["Choices you can name with game_act, by ref:"];
    for (const object of near) out.push(...objectLines(object));
    if (queue.length) {
      out.push("What you are doing now:");
      for (const object of queue) out.push(...objectLines(object, { queue: true }));
    }
    const groups = new Map<string, OptionObject[]>();
    for (const object of kept) {
      const room = typeof object.room === "string" && object.room !== "" ? object.room : OTHER_ROOMS;
      groups.set(room, [...(groups.get(room) ?? []), object]);
    }
    if (groups.size) out.push("Elsewhere on the lot:");
    for (const [room, objects] of groups) out.push(...roomLines(room, objects));
    return out;
  };
  let kept = rest;
  let lines = block(kept);
  while (kept.length > 0 && used(lines) > budget) {
    kept = kept.slice(0, -1);
    lines = block(kept);
  }
  const more = optionsCutLine(rest.length - kept.length + (cut?.objects ?? 0));
  return more ? [...lines, more] : lines;
}

/**
 * One room under the "Elsewhere on the lot" heading: its name, the no-way sentence it shares once when every object there
 * carries the same one (VIEW3-12), and its objects.
 */
function roomLines(room: string, objects: readonly OptionObject[]): string[] {
  const first = objects[0]?.noWay;
  const shared = typeof first === "string" && objects.every((object) => object.noWay === first) ? first : undefined;
  return [
    `${room}:`,
    ...(shared !== undefined ? [`  ${withStop(capitalised(dropTokens(shared)))}`] : []),
    ...objects.flatMap((object) => objectLines(object, { underRoom: true, noWayInHeading: shared !== undefined })),
  ];
}

/** The count line goes right after her money line; with no money line, it closes the body block. */
function withCountLine(lines: string[], counts: string | undefined): string[] {
  if (counts === undefined) return lines;
  const money = lines.findIndex((line) => line.startsWith("Money: "));
  if (money === -1) return [...lines, counts];
  return [...lines.slice(0, money + 1), counts, ...lines.slice(money + 1)];
}

/** Near her: the helper's near flag, or a where that starts "here" (what older helpers send). */
function isNear(object: OptionObject): boolean {
  return object.near === true || (typeof object.where === "string" && object.where.startsWith("here"));
}

/** Her queue: the helper's queue object, which has no room (its where is "your queue"). */
function isQueue(object: OptionObject): boolean {
  const hasRoom = typeof object.room === "string" && object.room !== "";
  return !hasRoom && (object.object_id === QUEUE_OBJECT_ID || object.where === QUEUE_WHERE);
}

/** The helper's words for a refused act the game gave no reason for (see the helper's refusal lines). */
const NO_REASON = ": refused: no reason given";
/** The helper's words for an act left out of the menu: "<act>: left out: <reason>". */
const LEFT_OUT = /^(.*?): left out: (.*)$/;
/** The helper's count for the acts past its line cap, one line per reason: "<N> more acts: left out: <reason>" (R5). */
const LEFT_OUT_MORE = /^(\d+) more acts?: left out: (.*)$/;
/** The most acts of one left-out reason the view names; more are said as a count. */
const LEFT_OUT_NAMED_MAX = 5;

/**
 * The refusals and left-out acts of one object, in plain words. A refusal with a reason stays word for word. The refusals
 * the game gave no reason for become one count line. The left-out acts become one line, grouped by reason; the helper's
 * "more acts" count for a reason adds to that reason's count (R5).
 */
function awayLines(refused: readonly string[], leftOut: readonly string[]): string[] {
  const groups = new Map<string, { acts: string[]; more: number }>();
  const group = (reason: string) => {
    const found = groups.get(reason) ?? { acts: [], more: 0 };
    groups.set(reason, found);
    return found;
  };
  const words: string[] = [];
  let withoutReason = 0;
  for (const raw of [...refused, ...leftOut]) {
    const line = dropTokens(raw);
    const more = LEFT_OUT_MORE.exec(line);
    const left = more ? undefined : LEFT_OUT.exec(line);
    if (more) {
      group(more[2] ?? "").more += Number(more[1]);
    } else if (left) {
      group(left[2] ?? "").acts.push(left[1] ?? "");
    } else if (line.endsWith(NO_REASON)) {
      withoutReason++;
    } else {
      words.push(line);
    }
  }
  const lines: string[] = [...words];
  if (withoutReason > 0) {
    lines.push(`${withoutReason} more ${withoutReason === 1 ? "act" : "acts"} the game does not offer here now.`);
  }
  if (groups.size) {
    // A small group names its acts; a large one, or one the helper counted past its cap, is said as a count, so a long
    // list of cheat acts does not fill the view.
    const parts = [...groups].map(([reason, { acts, more }]) => {
      const total = acts.length + more;
      const named = more === 0 && total <= LEFT_OUT_NAMED_MAX ? acts.join(", ") : `${total} ${total === 1 ? "act" : "acts"}`;
      return `${named} (${reason})`;
    });
    lines.push(`Left out of your phone: ${parts.join("; ")}.`);
  }
  return lines;
}

/**
 * One object's line, its states, the game's reasons and the acts left out under it, and its answer rules when it is a question.
 * Under a room heading the object's place is its distance only ("elsewhere" is said by the heading), and a no-way sentence
 * the room says once is not repeated. Her queue has no name of its own: its heading says what it is (VIEW3-27).
 */
function objectLines(object: OptionObject, shape: { underRoom?: boolean; noWayInHeading?: boolean; queue?: boolean } = {}): string[] {
  const place = shape.underRoom ? object.where?.replace(/^elsewhere(, )?/, "") : object.where;
  const where = place ? ` (${place})` : "";
  const noWay = typeof object.noWay === "string" && !shape.noWayInHeading ? ` [${object.noWay}]` : "";
  const acts = object.acts
    .filter((act) => act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string")
    .map((act) => `${act.ref} ${dropTokens(act.text)}${act.needs_sim === true ? " (needs a Sim: name one with sim)" : ""}${typeof act.opens === "string" ? ` [${act.opens}]` : ""}`)
    .join("; ");
  const lines = [shape.queue ? `- ${acts}` : `- ${dropTokens(object.object)}${where}${noWay}: ${acts}`];
  if (object.states?.length) lines.push(`  States: ${object.states.map((state) => dropTokens(state)).join(", ")}.`);
  for (const line of awayLines(object.refused ?? [], object.left_out ?? [])) lines.push(`  ${line}`);
  const rules = answerRulesOf(object);
  if (rules) lines.push(`  Answer rules: ${describeRules(rules)}.`);
  return lines;
}

/**
 * The choices as a set of (ref, words, no-way, opens, room, near, states, refusals, left-out acts), ignoring distances; "" when
 * there are none. A move from one room to another, or into or out of near, is a change of choices (C7). So is a change of a
 * state, a refusal or a left-out act: the choices are listed again then (T3).
 */
export function choicesSignature(options: readonly OptionObject[]): string {
  const rows = new Set<string>();
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string") {
        const noWay = typeof object.noWay === "string" ? object.noWay : null;
        const opens = typeof act.opens === "string" ? act.opens : null;
        const room = typeof object.room === "string" ? object.room : null;
        const words = [object.states ?? null, object.refused ?? null, object.left_out ?? null];
        rows.add(JSON.stringify([act.ref, act.text, noWay, opens, room, isNear(object), ...words]));
      }
    }
  }
  return [...rows].sort().join("\n");
}

/**
 * A look that changed nothing answers in one line (D2): the look is the only thing the game sent, the choices are the same
 * as the last view's, and the view carries no day record. "Changed" means what the game sent as change, its feed; the
 * body block of the last view still stands, except for the clock, which the line gives. Undefined when the view is not that.
 */
export function unchangedLookLine(input: {
  percepts: readonly Percept[]; options: readonly OptionObject[] | undefined; lastChoices: string | undefined;
  portrait: unknown; hasDay: boolean;
}): string | undefined {
  if (input.hasDay || input.options === undefined || input.lastChoices === undefined) return undefined;
  if (!input.percepts.some((item) => item.kind === "look") || input.percepts.some((item) => item.kind !== "look")) return undefined;
  if (choicesSignature(input.options) !== input.lastChoices) return undefined;
  const portrait = input.portrait !== null && typeof input.portrait === "object" && !Array.isArray(input.portrait)
    ? input.portrait as Record<string, unknown> : {};
  const clock = clockLine(portrait);
  return `Your look: no change in the game since your last view, and the choices are the same.${clock ? ` ${clock}` : ""}`;
}

/** The line that says how many things on the lot are not in the choices, for the game's cut or the view's own cut. */
function optionsCutLine(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `${count} more ${count === 1 ? "thing" : "things"} on the lot ${count === 1 ? "is" : "are"} not listed, to keep this view short.`;
}
