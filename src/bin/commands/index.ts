// Dispatches the newer command-line commands. Each lives in its own module here. `chat` stays in natalis.ts.
// Returns undefined for a command this module does not own, so the caller can handle it.

import { captureCommand } from "./capture.js";
import { importCommand } from "./import.js";
import { judgeCommand } from "./judge.js";
import { replayCommand } from "./replay.js";

export async function dispatchCommand(command: string | undefined, args: string[]): Promise<number | undefined> {
  switch (command) {
    case "import":
      return importCommand(args);
    case "capture":
      return captureCommand(args);
    case "replay":
      return replayCommand(args);
    case "judge":
      return judgeCommand(args);
    default:
      return undefined;
  }
}
