// A notebook as a turn outside the summoner's place and her own thread sees it: private/ is left out of the list,
// search and reads. Writes pass through unchanged; she can still keep things close from anywhere. A rename whose
// source is hidden is refused as not found, so a private note cannot be moved into the open from here.

import { NotebookError, type Notebook } from "../contracts.js";
import { notebookPathOf } from "./git-notebook.js";

export function isPrivatePath(path: string): boolean {
  return path === "private" || path.startsWith("private/");
}

/** True when the notebook reads the path as private, or cannot spell it at all: a path it cannot place stays hidden. */
function hidden(path: string): boolean {
  const normal = notebookPathOf(path);
  return normal === undefined || isPrivatePath(normal);
}

/** True when a listed path, in the notebook's own spelling, sits under private/. */
function hiddenEntry(path: string): boolean {
  return isPrivatePath(notebookPathOf(path) ?? path);
}

export function withoutPrivate(notebook: Notebook): Notebook {
  return {
    root: notebook.root,
    read: (path) => (hidden(path) ? null : notebook.read(path)),
    write: (...args) => notebook.write(...args),
    edit: (...args) => notebook.edit(...args),
    append: (...args) => notebook.append(...args),
    rename: (path, to, reason, author) => {
      // A hidden note cannot be moved from here, or the thread would learn it exists and could bring it into the open.
      if (hidden(path)) throw new NotebookError(`${notebookPathOf(path) ?? path} does not exist.`, "not_found");
      return notebook.rename(path, to, reason, author);
    },
    remove: (...args) => notebook.remove(...args),
    list: (dir) => notebook.list(dir).filter((entry) => !hiddenEntry(entry.path)),
    search: (text, limit) => notebook.search(text, limit === undefined ? undefined : limit * 4).filter((hit) => !hiddenEntry(hit.path)).slice(0, limit),
    ...(notebook.lineTimes ? { lineTimes: (path: string) => (hidden(path) ? null : notebook.lineTimes?.(path) ?? null) } : {}),
  };
}
