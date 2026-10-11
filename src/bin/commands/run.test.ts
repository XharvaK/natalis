import { describe, expect, it } from "vitest";
import { parseDiscordFile } from "./run.js";

describe("discord.json", () => {
  it("reads the token's variable name, the owner and the rooms", () => {
    expect(parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", rooms: ["5678"] })).toEqual({
      tokenEnv: "TEST_BOT_TOKEN",
      ownerUserId: "1234",
      rooms: ["5678"],
    });
    expect(parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234" }).rooms).toEqual([]);
  });

  it("refuses a token written in place of its variable name, and unknown fields", () => {
    const tokenShaped = ["abc", "def", "ghi"].join(".");
    expect(() => parseDiscordFile({ tokenEnv: tokenShaped, ownerUserId: "1", rooms: [] })).toThrow(/tokenEnv/);
    expect(() => parseDiscordFile({ token: "x", tokenEnv: "T", ownerUserId: "1" })).toThrow(/Unknown field "token"/);
    expect(() => parseDiscordFile({ tokenEnv: "T", ownerUserId: "mara" })).toThrow(/ownerUserId/);
    expect(() => parseDiscordFile({ tokenEnv: "T", ownerUserId: "1", rooms: ["general"] })).toThrow(/rooms/);
  });
});
