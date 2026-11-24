import { describe, expect, it } from "vitest";
import { KANTUS_DEFAULT_HOST, KANTUS_DEFAULT_PORT, KANTUS_FILE, parseKantusFile } from "./file.js";

describe("kantus.json", () => {
  it("reads the token's variable name, and fills in where the bridge listens", () => {
    expect(parseKantusFile({ tokenEnv: "TEST_KANTUS_TOKEN" })).toEqual({
      tokenEnv: "TEST_KANTUS_TOKEN", host: "127.0.0.1", port: 3721,
    });
    expect(parseKantusFile({ tokenEnv: "TEST_KANTUS_TOKEN", host: "100.64.0.1", port: 3722 })).toEqual({
      tokenEnv: "TEST_KANTUS_TOKEN", host: "100.64.0.1", port: 3722,
    });
    expect(KANTUS_FILE).toBe("kantus.json");
    expect(KANTUS_DEFAULT_HOST).toBe("127.0.0.1");
    expect(KANTUS_DEFAULT_PORT).toBe(3721);
  });

  it("refuses a token written in place of its variable name, an empty one, and any field it does not know", () => {
    const tokenShaped = ["abc", "def", "ghi"].join(".");
    expect(() => parseKantusFile({ tokenEnv: tokenShaped })).toThrow(/tokenEnv/);
    expect(() => parseKantusFile({ tokenEnv: "" })).toThrow(/tokenEnv/);
    expect(() => parseKantusFile({ token: "x", tokenEnv: "T" })).toThrow(/Unknown field "token"/);
    expect(() => parseKantusFile({ tokenEnv: "T", host: "" })).toThrow(/host/);
    expect(() => parseKantusFile({ tokenEnv: "T", port: "3721" })).toThrow(/port/);
    expect(() => parseKantusFile({ tokenEnv: "T", port: 3.5 })).toThrow(/port/);
    expect(() => parseKantusFile({ tokenEnv: "T", port: -1 })).toThrow(/port/);
    expect(() => parseKantusFile({ tokenEnv: "T", port: 65536 })).toThrow(/port/);
    expect(() => parseKantusFile(["T"])).toThrow(/must be an object/);
  });
});
