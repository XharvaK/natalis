// Reads a tool call's JSON arguments as they stream in, and hands out each top-level string field piece by piece.
// It never waits for the whole object: `text` can start being spoken while the model is still writing it.
// Handles escapes split across pieces (\n, \", \uXXXX and surrogate pairs). Non-string values are skipped.

export function createArgsReader(onField) {
  // onField(key, fragment, done): fragment is decoded text; done is true once that string value closed.
  let state = "start"; // start, key, afterKey, value, string, escape, unicode, other, afterValue, end
  let depth = 0; // nesting inside a non-string value (arrays, objects)
  let key = "";
  let inKey = false;
  let pending = ""; // decoded text not yet handed out
  let hex = "";
  let highSurrogate = null;
  let otherInString = false;
  let otherEscape = false;

  function flush(done) {
    if (!inKey && (pending.length > 0 || done)) onField(key, pending, done);
    pending = "";
  }

  function emitChar(ch) {
    if (inKey) key += ch;
    else pending += ch;
  }

  function push(chunk) {
    for (const ch of chunk) {
      switch (state) {
        case "start":
          if (ch === "{") state = "afterValue";
          else if (!/\s/.test(ch)) throw new Error(`arguments must be an object, got ${JSON.stringify(ch)}`);
          break;
        case "afterValue":
          if (ch === '"') { state = "string"; inKey = true; key = ""; }
          else if (ch === "}") state = "end";
          else if (ch !== "," && !/\s/.test(ch)) throw new Error(`unexpected ${JSON.stringify(ch)} between fields`);
          break;
        case "afterKey":
          if (ch === ":") state = "value";
          else if (!/\s/.test(ch)) throw new Error(`expected a colon after "${key}"`);
          break;
        case "value":
          if (/\s/.test(ch)) break;
          if (ch === '"') { state = "string"; inKey = false; }
          else { state = "other"; depth = ch === "{" || ch === "[" ? 1 : 0; otherInString = false; if (depth === 0) state = "scalar"; }
          break;
        case "scalar": // a number, true, false or null: ends at a comma or the closing brace
          if (ch === ",") state = "afterValue";
          else if (ch === "}") state = "end";
          break;
        case "other": // an array or object value: skipped, strings inside it included
          if (otherInString) {
            if (otherEscape) otherEscape = false;
            else if (ch === "\\") otherEscape = true;
            else if (ch === '"') otherInString = false;
          } else if (ch === '"') otherInString = true;
          else if (ch === "{" || ch === "[") depth += 1;
          else if (ch === "}" || ch === "]") { depth -= 1; if (depth === 0) state = "afterValue"; }
          break;
        case "string":
          if (ch === "\\") state = "escape";
          else if (ch === '"') {
            if (inKey) { inKey = false; state = "afterKey"; }
            else { flush(true); state = "afterValue"; }
          } else emitChar(ch);
          break;
        case "escape": {
          const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }[ch];
          if (ch === "u") { state = "unicode"; hex = ""; }
          else if (simple !== undefined) { emitChar(simple); state = "string"; }
          else throw new Error(`bad escape \\${ch}`);
          break;
        }
        case "unicode":
          hex += ch;
          if (hex.length === 4) {
            const code = parseInt(hex, 16);
            if (Number.isNaN(code)) throw new Error(`bad \\u escape ${hex}`);
            if (code >= 0xd800 && code <= 0xdbff) highSurrogate = code;
            else if (code >= 0xdc00 && code <= 0xdfff && highSurrogate !== null) {
              emitChar(String.fromCharCode(highSurrogate, code));
              highSurrogate = null;
            } else emitChar(String.fromCharCode(code));
            state = "string";
          }
          break;
        case "end":
          if (!/\s/.test(ch)) throw new Error("text after the closing brace");
          break;
      }
    }
    if (state === "string" || state === "escape" || state === "unicode") flush(false);
  }

  return {
    push,
    get closed() { return state === "end"; },
  };
}
