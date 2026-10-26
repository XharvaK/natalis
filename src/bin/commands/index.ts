// Dispatches the newer command-line commands. Each lives in its own module here. `chat` stays in natalis.ts.
// Returns undefined for a command this module does not own, so the caller can handle it.

import { backupCommand } from "./backup.js";
import { captureCommand } from "./capture.js";
import { checkCommand } from "./check.js";
import { evalCommand } from "./eval.js";
import { importCommand } from "./import.js";
import { judgeCommand } from "./judge.js";
import { ledgerCommand } from "./ledger.js";
import { newCommand } from "./new.js";
import { proposalsCommand } from "./proposals.js";
import { replayCommand } from "./replay.js";
import { restoreCommand } from "./restore.js";
import { unsealCommand } from "./unseal.js";
import { readHiddenLine, vaultCommand } from "./vault.js";

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
    case "backup":
      return backupCommand(args);
    case "restore":
      return restoreCommand(args);
    case "unseal":
      return unsealCommand(args);
    case "proposals":
      return proposalsCommand(args);
    case "ledger":
      return ledgerCommand(args, (line) => console.log(line), (line) => console.error(line));
    case "vault":
      return vaultCommand(args, readHiddenLine, (line) => console.log(line), (line) => console.error(line));
    case "new":
      return newCommand(args, (line) => console.log(line), (line) => console.error(line));
    case "eval":
      return evalCommand(args);
    case "check":
      return checkCommand(args, (line) => console.log(line), (line) => console.error(line));
    default:
      return undefined;
  }
}
