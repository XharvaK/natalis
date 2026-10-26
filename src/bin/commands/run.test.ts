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

describe("after Stopped., round 6", () => {
  it("P1-2: the process is made to exit after a short grace if the event loop does not drain", async () => {
    const { armExitFailsafe } = await import("./run.js");
    const codes: number[] = [];
    const timer = armExitFailsafe(0, 10, (code) => codes.push(code));
    await new Promise((r) => setTimeout(r, 40));
    expect(codes).toEqual([0]);
    expect(timer.hasRef()).toBe(false);
  });
});
