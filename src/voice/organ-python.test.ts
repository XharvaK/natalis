import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const python = process.env["NATALIS_ORGAN_PYTHON"];
const organDir = fileURLToPath(new URL("../../organ/", import.meta.url));

describe.skipIf(python === undefined || python === "")("the voice organ's Python tests", () => {
  it("pass in the organ's venv", () => {
    const result = spawnSync(python as string, ["-m", "unittest", "-v", "test_voice_organ"], {
      cwd: organDir, encoding: "utf8", timeout: 900_000, windowsHide: true, env: process.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 900_000);
});
