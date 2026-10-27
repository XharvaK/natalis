// Test-only module loader: the TypeScript source imports the build's ".js" names, while Node's type
// stripping runs the real ".ts" files. Resolve a relative ".js" to its ".ts" neighbour when that exists.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL !== undefined) {
    const url = new URL(specifier, context.parentURL);
    if (url.protocol === "file:") {
      const ts = new URL(`${url.href.slice(0, -3)}.ts`);
      if (existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
