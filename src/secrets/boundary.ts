// The floor says credentials never enter a model request or the entity's memory. These wrappers put the byte
// check at the boundaries instead of at each caller: whatever is written to the river or the notebook, and
// whatever is sent to the model, passes through the scanner first. They judge nothing; they only replace bytes.

import type { ChatMessage, ModelPort, Notebook, River, RiverRowInput, SecretScanner } from "../contracts.js";

/** Every string in the data, keys included, scanned as the text it is. Numbers, booleans and null pass as they are. */
function redactStrings(scanner: SecretScanner, value: unknown): unknown {
  if (typeof value === "string") return scanner.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(scanner, item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [scanner.redact(key), redactStrings(scanner, item)]),
    );
  }
  return value;
}

function redactData(scanner: SecretScanner, data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  // Strings are scanned one by one, so a known value written escaped inside a string (as a model's JSON
  // arguments write it) is seen as it is, not doubly escaped by JSON.stringify.
  const walked = redactStrings(scanner, data) as Record<string, unknown>;
  // Then the whole JSON text, for anything the walk cannot see (a number that is a known value, say).
  const text = JSON.stringify(walked);
  const clean = scanner.redact(text);
  if (clean === text) return walked;
  try {
    return JSON.parse(clean) as Record<string, unknown>;
  } catch {
    // A hit that broke the JSON shape: keep the cleaned text rather than the secret.
    return { redacted: clean };
  }
}

export function guardRiver(river: River, scanner: SecretScanner): River {
  return {
    append(row: RiverRowInput) {
      return river.append({
        ...row,
        ...(row.text !== undefined ? { text: scanner.redact(row.text) } : {}),
        ...(row.data !== undefined ? { data: redactData(scanner, row.data) } : {}),
      });
    },
    read: (query) => river.read(query),
    count: (query) => river.count(query),
    search: (text, options) => river.search(text, options),
    forget: (match, by, reason) => river.forget(match, by, scanner.redact(reason)),
    lastSeq: () => river.lastSeq(),
    close: () => river.close(),
  };
}

export function guardNotebook(notebook: Notebook, scanner: SecretScanner): Notebook {
  return {
    root: notebook.root,
    read: (path) => notebook.read(path),
    write: (path, text, reason, author) => notebook.write(path, scanner.redact(text), scanner.redact(reason), author),
    edit: (path, find, replace, reason, author) =>
      notebook.edit(path, find, scanner.redact(replace), scanner.redact(reason), author),
    append: (path, text, reason, author) => notebook.append(path, scanner.redact(text), scanner.redact(reason), author),
    remove: (path, reason, author) => notebook.remove(path, scanner.redact(reason), author),
    list: (dir) => notebook.list(dir),
    search: (text, limit) => notebook.search(text, limit),
  };
}

function guardMessage(scanner: SecretScanner, message: ChatMessage): ChatMessage {
  switch (message.role) {
    case "system":
    case "user":
    case "tool":
      return { ...message, content: scanner.redact(message.content) };
    case "assistant":
      return {
        ...message,
        content: message.content === null ? null : scanner.redact(message.content),
        ...(message.toolCalls
          ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: scanner.redact(call.arguments) })) }
          : {}),
      };
  }
}

export function guardModel(model: ModelPort, scanner: SecretScanner): ModelPort {
  const routing = model.routing;
  return {
    info: model.info,
    complete: (request, signal) =>
      model.complete({ ...request, messages: request.messages.map((message) => guardMessage(scanner, message)) }, signal),
    ...(routing === undefined ? {} : { routing }),
  };
}
