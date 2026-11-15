import { describe, expect, it } from "vitest";
import { createSecretScanner } from "../secrets/index.js";
import { proposalFirstLine } from "./proposals-digest.js";

const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

function scanner() {
  return createSecretScanner({ knownValues: ["vault-value-0123456789"] });
}

describe("the first line of a proposal", () => {
  it("strips leading # and spaces, redacts, and clips to 150 characters with an ellipsis", () => {
    expect(proposalFirstLine("\n\n  ## A search tool\nBody.\n", scanner())).toBe("A search tool");

    const long = "a".repeat(200);
    const line = proposalFirstLine(`# Use ${FAKE_KEY} ${long}\n`, scanner());
    expect(line).not.toContain(FAKE_KEY);
    expect(line).toContain("[secret:openai_sk]");
    expect(line.endsWith("…")).toBe(true);
    expect(Array.from(line).length).toBe(151);
    expect(proposalFirstLine("   \n\n", scanner())).toBe("");
  });
});
