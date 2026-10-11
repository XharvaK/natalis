import { describe, expect, it } from "vitest";
import { parseDomusFile } from "./file.js";

describe("domus.json", () => {
  it("reads the token's variable name, and where to listen, with the defaults left to the world", () => {
    expect(parseDomusFile({ tokenEnv: "TEST_DOMUS_TOKEN" })).toEqual({ tokenEnv: "TEST_DOMUS_TOKEN" });
    expect(parseDomusFile({ tokenEnv: "TEST_DOMUS_TOKEN", host: "127.0.0.1", port: 3711 })).toEqual({
      tokenEnv: "TEST_DOMUS_TOKEN", host: "127.0.0.1", port: 3711,
    });
  });

  it("refuses a token written in place of its variable name, and any field it does not know", () => {
    const tokenShaped = ["abc", "def", "ghi"].join(".");
    expect(() => parseDomusFile({ tokenEnv: tokenShaped })).toThrow(/tokenEnv/);
    expect(() => parseDomusFile({ token: "x", tokenEnv: "T" })).toThrow(/Unknown field "token"/);
    expect(() => parseDomusFile({ tokenEnv: "T", host: "" })).toThrow(/host/);
    expect(() => parseDomusFile({ tokenEnv: "T", port: "3711" })).toThrow(/port/);
    expect(() => parseDomusFile({ tokenEnv: "T", port: 70000 })).toThrow(/port/);
    expect(() => parseDomusFile(["T"])).toThrow(/must be an object/);
  });
});
