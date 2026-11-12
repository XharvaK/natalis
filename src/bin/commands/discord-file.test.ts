import { describe, expect, it } from "vitest";
import { parseDiscordFile } from "./discord-file.js";

describe("discord.json's window", () => {
  it("keeps a window channel that is digits only", () => {
    expect(parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", rooms: ["5678"], window: "9012" })).toEqual({
      tokenEnv: "TEST_BOT_TOKEN",
      ownerUserId: "1234",
      rooms: ["5678"],
      window: "9012",
    });
  });

  it("leaves the window out when none is named", () => {
    expect(parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234" })).not.toHaveProperty("window");
  });

  it("refuses a window that is not a channel id", () => {
    expect(() => parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", window: "abc" })).toThrow(
      "discord.json: window must be a channel id, digits only.",
    );
    expect(() => parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", window: 5678 })).toThrow(
      "discord.json: window must be a channel id, digits only.",
    );
  });

  it("lists window among the allowed fields when a field is unknown", () => {
    expect(() => parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", channel: "5678" })).toThrow(
      'Unknown field "channel" in discord.json. Allowed: tokenEnv, ownerUserId, rooms, window.',
    );
  });
});
