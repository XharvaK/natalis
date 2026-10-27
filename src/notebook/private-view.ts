// A notebook as a turn outside the summoner's place and her own thread sees it: private/ is left out of the list,
// search and reads. Writes pass through unchanged; she can still keep things close from anywhere.

import type { Notebook } from "../contracts.js";

export function isPrivatePath(path: string): boolean {
  return path === "private" || path.startsWith("private/");
}

export function withoutPrivate(notebook: Notebook): Notebook {
  return {
    root: notebook.root,
    read: (path) => (isPrivatePath(path) ? null : notebook.read(path)),
    write: (...args) => notebook.write(...args),
    edit: (...args) => notebook.edit(...args),
    append: (...args) => notebook.append(...args),
    rename: (...args) => notebook.rename(...args),
    remove: (...args) => notebook.remove(...args),
    list: (dir) => notebook.list(dir).filter((entry) => !isPrivatePath(entry.path)),
    search: (text, limit) => notebook.search(text, limit === undefined ? undefined : limit * 4).filter((hit) => !isPrivatePath(hit.path)).slice(0, limit),
  };
}
