// A body for world tests: its outward check reads the Lar's privacy.json the way the runtime's body does. Pictures are
// not kept through it; a test that needs them uses its own body.

import { join } from "node:path";
import type { WorldBody } from "../contracts.js";
import { createPrivacyWatch, outwardHold, PRIVACY_FILE } from "../entity/privacy.js";

export function privacyBody(dir: string): WorldBody {
  const watch = createPrivacyWatch(join(dir, PRIVACY_FILE));
  return {
    keepPicture() {
      throw new Error("Pictures are not kept in this test.");
    },
    outwardHold: (texts) => outwardHold(watch.current(), texts),
  };
}
