// The default folders of a new entity's notebook. Each folder gets a README.md in plain words, written by the body.

import type { Notebook } from "../contracts.js";

export type LayoutFolder = { folder: string; purpose: string };

export const ENTITY_LAYOUT: readonly LayoutFolder[] = [
  { folder: "self", purpose: "Who I am: my name, my character, and what I have settled about myself." },
  { folder: "memory", purpose: "Things I remember that I chose to keep, in my own words." },
  { folder: "people", purpose: "One note per person I know: what they told me and what I owe them." },
  { folder: "places", purpose: "The rooms, websites and other places I go, and what each one is like." },
  { folder: "diary", purpose: "Dated entries about my days, written as they happen." },
  { folder: "projects", purpose: "Work I am doing over time, one file or folder per project." },
  { folder: "problems", purpose: "Problems I am stuck on or working through, and what I have tried." },
  { folder: "skills", purpose: "Things I have learned to do, written as steps I can follow." },
  { folder: "questions", purpose: "Open questions I want to answer later." },
  { folder: "wants", purpose: "Things I want or intend, written down so I can see them." },
  { folder: "lessons", purpose: "What went well or badly, and what I will do differently next time." },
  { folder: "calendar", purpose: "Dates and times that matter to me or to people I know." },
  { folder: "letters", purpose: "Letters I wrote, drafted or sent." },
  { folder: "creations", purpose: "Things I made: stories, descriptions, songs, code." },
  { folder: "collection", purpose: "Things I keep: links, quotes, and objects described in words." },
  { folder: "library", purpose: "Texts I have read or saved, with where each one came from." },
  { folder: "world", purpose: "What I know about the world beyond my own notebook." },
  { folder: "game", purpose: "Notes from games I play, such as what happened in them." },
  {
    folder: "accounts",
    purpose: "Which accounts I have and what they are for. Never passwords, tokens or keys.",
  },
  { folder: "body", purpose: "Facts about my own host: restarts, model changes, backups." },
  { folder: "inbox", purpose: "Things that arrived and are not yet sorted into a folder." },
  { folder: "dreams", purpose: "Things that came up while nobody was talking with me." },
  { folder: "private", purpose: "Things I keep close. Not read out or shared unless I choose to." },
  {
    folder: "trash",
    purpose: "Removed files, moved here by date. Nothing is deleted; anything here can be taken back out.",
  },
];

export const SEED_AUTHOR = "body";

export function readmeText(entry: LayoutFolder): string {
  return [
    `# ${entry.folder}`,
    "",
    entry.purpose,
    "",
    "This folder is part of my notebook. Every change in it is a commit with a reason.",
    "Removed files go to trash/ by date instead of being deleted.",
    "",
  ].join("\n");
}

/**
 * Write a README.md into each default folder that does not have one yet. A README the entity already wrote
 * is left alone, so seeding twice changes nothing.
 */
export async function seedNotebook(notebook: Notebook): Promise<void> {
  for (const entry of ENTITY_LAYOUT) {
    const path = `${entry.folder}/README.md`;
    if (notebook.read(path) !== null) continue;
    await notebook.write(path, readmeText(entry), `Explain the ${entry.folder} folder`, SEED_AUTHOR);
  }
}
