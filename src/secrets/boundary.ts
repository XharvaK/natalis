// The floor says credentials never enter a model request or the entity's memory. These wrappers put the byte
// check at the boundaries instead of at each caller: whatever is written to the river or the notebook, and
// whatever is sent to the model, passes through the scanner first. They judge nothing; they only replace bytes.

import type { ChatMessage, ModelPort, Notebook, River, RiverRowInput, SecretScanner } from "../contracts.js";

function redactData(scanner: SecretScanner, data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  const text = JSON.stringify(data);
  const clean = scanner.redact(text);
  if (clean === text) return data;
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
  return {
    info: model.info,
    complete: (request, signal) =>
      model.complete({ ...request, messages: request.messages.map((message) => guardMessage(scanner, message)) }, signal),
  };
}
