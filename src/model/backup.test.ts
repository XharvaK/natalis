import { describe, expect, it } from "vitest";
import { ModelError, type ModelPort, type ModelRequest, type ModelResponse } from "../contracts.js";
import { PICTURE_STAND_IN, bothResets, estimateTokens, withBackup, withoutPictures } from "./backup.js";

/** A port that answers with the given result each time it is asked, and counts its calls. */
function port(name: string, result: ModelResponse | Error): ModelPort & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    info: { id: `fake:${name}`, contextTokens: 8000, nativeTools: true },
    requests,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const answer = (content: string): ModelResponse => ({ content, toolCalls: [], finish: "stop", latencyMs: 1 });

const PICTURE = { type: "image" as const, mime: "image/png", dataBase64: "AAAA" };

const request: ModelRequest = {
  messages: [
    { role: "system", content: "You are the Lar." },
    { role: "user", content: "Look at this.", images: [PICTURE] },
  ],
  tools: [{ name: "end_turn", description: "end", parameters: {} }],
};

describe("the backup model", () => {
  it("is tried when the main model is out of credit, and the answer says which model answered", async () => {
    const main = port("main", new ModelError("model service is out of credit (HTTP 402)", "out_of_credit", 1));
    const backup = port("backup", answer("from the backup"));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });
    const reply = await model.complete(request);
    expect(reply).toMatchObject({ content: "from the backup", servedBy: "backup-model" });
    expect(backup.requests).toHaveLength(1);
  });

  it("answers in place of the main model when the main model fails with a service failure", async () => {
    for (const kind of ["rate_limit", "unavailable", "timeout"] as const) {
      const main = port("main", new ModelError("service is down", kind, 4));
      const backup = port("backup", answer("from the backup"));
      const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

      const reply = await model.complete(request);

      expect(reply).toMatchObject({ content: "from the backup", servedBy: "backup-model" });
      expect(main.requests).toHaveLength(1);
      expect(backup.requests).toHaveLength(1);
    }
  });

  it("leaves servedBy out when the main model answers, and never calls the backup", async () => {
    const main = port("main", answer("from the main"));
    const backup = port("backup", answer("from the backup"));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    const reply = await model.complete(request);

    expect(reply.content).toBe("from the main");
    expect(reply).not.toHaveProperty("servedBy");
    expect(backup.requests).toHaveLength(0);
  });

  it("is not used when the caller aborts, even if the failure was a service one", async () => {
    const controller = new AbortController();
    const main: ModelPort = {
      info: { id: "fake:main", contextTokens: 8000, nativeTools: true },
      async complete() {
        controller.abort();
        throw new ModelError("service is down", "unavailable", 1);
      },
    };
    const backup = port("backup", answer("from the backup"));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    await expect(model.complete(request, controller.signal)).rejects.toMatchObject({ kind: "unavailable" });
    expect(backup.requests).toHaveLength(0);
  });

  it("is not used when the caller had already aborted, and the abort is what is thrown", async () => {
    const controller = new AbortController();
    controller.abort();
    const main = port("main", new ModelError("request aborted by caller", "aborted", 1));
    const backup = port("backup", answer("from the backup"));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    await expect(model.complete(request, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(backup.requests).toHaveLength(0);
  });

  it("is not used on a refused key (401, 403), a refused request (400) or a malformed reply", async () => {
    for (const kind of ["auth", "bad_request", "malformed"] as const) {
      const main = port("main", new ModelError("refused", kind, 1));
      const backup = port("backup", answer("from the backup"));
      const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

      await expect(model.complete(request)).rejects.toMatchObject({ kind });
      expect(backup.requests).toHaveLength(0);
    }
  });

  it("is not used for an error that is not a model failure at all", async () => {
    const main = port("main", new TypeError("a bug in the body"));
    const backup = port("backup", answer("from the backup"));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    await expect(model.complete(request)).rejects.toThrow("a bug in the body");
    expect(backup.requests).toHaveLength(0);
  });

  it("hands the backup the system message exactly as the main model got it, with or without pictures", async () => {
    for (const backupSeesPictures of [true, false]) {
      const main = port("main", new ModelError("service is down", "unavailable", 4));
      const backup = port("backup", answer("from the backup"));
      const model = withBackup({ primary: main, backup, backupName: "backup-model", backupEffort: "low", backupSeesPictures });

      await model.complete(request);

      // Who she is lives in the system message: a model swap must never leave it behind (the persona anchor).
      expect(backup.requests[0]?.messages[0]).toEqual(request.messages[0]);
      expect(backup.requests[0]?.messages[0]).toBe(main.requests[0]?.messages[0]);
    }
  });

  it("strips the pictures for a backup that cannot see them, and says so in their place", async () => {
    const main = port("main", new ModelError("service is down", "unavailable", 4));
    const backup = port("backup", answer("I cannot see it, but I can answer."));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: false });

    await model.complete(request);

    const sent = backup.requests[0]?.messages[1];
    expect(sent).toEqual({ role: "user", content: `Look at this.\n${PICTURE_STAND_IN}` });
    expect(JSON.stringify(backup.requests[0])).not.toContain("AAAA");
    // The main model's request is not changed by the stripping.
    expect(request.messages[1]).toEqual({ role: "user", content: "Look at this.", images: [PICTURE] });
  });

  it("keeps the pictures for a backup that can see them", async () => {
    const main = port("main", new ModelError("service is down", "unavailable", 4));
    const backup = port("backup", answer("I can see it."));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    await model.complete(request);

    expect(backup.requests[0]).toBe(request);
  });

  it("throws the backup's failure and names the main model's failure too, when both fail", async () => {
    const main = port("main", new ModelError("main is down", "unavailable", 4));
    const backup = port("backup", new ModelError("backup is rate limited", "rate_limit", 4));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    const failure = await model.complete(request).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ModelError);
    expect((failure as ModelError).kind).toBe("rate_limit");
    expect((failure as ModelError).message).toBe("backup is rate limited. The main model failed first: main is down");
  });

  it("reports the main model's identity, since the backup is the same service", () => {
    const main = port("main", answer("x"));
    const model = withBackup({ primary: main, backup: port("backup", answer("y")), backupName: "b", backupSeesPictures: false });
    expect(model.info).toEqual(main.info);
  });

  it("sends the backup its own effort when given, and the request's effort when not", async () => {
    const failing = new ModelError("service is down", "unavailable", 4);
    const withEffort = port("backup", answer("ok"));
    await withBackup({ primary: port("main", failing), backup: withEffort, backupName: "b", backupSeesPictures: true, backupEffort: "xhigh" })
      .complete({ ...request, effort: "low" });
    expect(withEffort.requests[0]?.effort).toBe("xhigh");

    const without = port("backup", answer("ok"));
    await withBackup({ primary: port("main", failing), backup: without, backupName: "b", backupSeesPictures: true })
      .complete({ ...request, effort: "low" });
    expect(without.requests[0]?.effort).toBe("low");
  });

  it("is not tried for a request too big for the backup's context, and says why in the error", async () => {
    const big: ModelRequest = { messages: [{ role: "user", content: "x".repeat(4000) }], maxOutputTokens: 100 };
    const backup = port("backup", answer("should not be sent"));
    const model = withBackup({
      primary: port("main", new ModelError("main is busy", "rate_limit", 4)),
      backup,
      backupName: "backup-model",
      backupSeesPictures: true,
      backupContextTokens: 500,
    });

    const failure = await model.complete(big).catch((err: unknown) => err);

    expect(backup.requests).toHaveLength(0);
    expect(failure).toBeInstanceOf(ModelError);
    expect((failure as ModelError).kind).toBe("rate_limit");
    expect((failure as ModelError).message).toBe(
      "main is busy. The backup model (backup-model) was not tried: this request is about 1100 tokens, more than its 500-token context.",
    );
  });

  it("is tried for a request that fits the backup's context", async () => {
    const backup = port("backup", answer("fits"));
    const model = withBackup({
      primary: port("main", new ModelError("main is busy", "unavailable", 4)),
      backup,
      backupName: "backup-model",
      backupSeesPictures: true,
      backupContextTokens: 10_000,
    });
    await expect(model.complete(request)).resolves.toMatchObject({ content: "fits", servedBy: "backup-model" });
    expect(backup.requests).toHaveLength(1);
  });

  it("checks the size after the pictures are stripped, so a picture the backup cannot see does not count", async () => {
    const huge = "AAAA".repeat(200_000);
    const withHuge: ModelRequest = {
      messages: [{ role: "user", content: "small", images: [{ type: "image", mime: "image/png", dataBase64: huge }] }],
    };
    const backup = port("backup", answer("fits"));
    const model = withBackup({
      primary: port("main", new ModelError("main is busy", "unavailable", 4)),
      backup,
      backupName: "backup-model",
      backupSeesPictures: false,
      backupContextTokens: 1000,
    });
    await expect(model.complete(withHuge)).resolves.toMatchObject({ servedBy: "backup-model" });
  });
});

describe("the backup hold", () => {
  /** A main model that is down until told otherwise, and counts its calls. */
  function flaky(): ModelPort & { calls: ModelRequest[]; down: boolean } {
    const calls: ModelRequest[] = [];
    const main = {
      info: { id: "fake:main", contextTokens: 8000, nativeTools: true },
      calls,
      down: true,
      async complete(sent: ModelRequest): Promise<ModelResponse> {
        calls.push(sent);
        if (main.down) throw new ModelError("service is down", "unavailable", 4);
        return answer("from the main model");
      },
    };
    return main;
  }

  it("sends the rest of a turn straight to the backup after the main model failed in it", async () => {
    const main = flaky();
    const backup = port("backup", answer("from the backup"));
    const model = withBackup({ primary: main, backup, backupName: "backup-model", backupSeesPictures: true });

    await model.complete({ ...request, turnId: "turn-1" });
    main.down = false;
    const again = await model.complete({ ...request, turnId: "turn-1" });

    expect(again).toMatchObject({ content: "from the backup", servedBy: "backup-model" });
    expect(again.mainError).toBe("it failed earlier in this turn (service is down), so this call went to the backup");
    expect(main.calls).toHaveLength(1);
    expect(backup.requests).toHaveLength(2);
  });

  it("tries the main model first on the next turn", async () => {
    const main = flaky();
    const model = withBackup({ primary: main, backup: port("backup", answer("from the backup")), backupName: "b", backupSeesPictures: true });

    await model.complete({ ...request, turnId: "turn-1" });
    main.down = false;
    const next = await model.complete({ ...request, turnId: "turn-2" });

    expect(next.content).toBe("from the main model");
    expect(next).not.toHaveProperty("servedBy");
    expect(next).not.toHaveProperty("mainError");
    expect(main.calls).toHaveLength(2);
  });

  it("never holds a call that has no turn", async () => {
    const main = flaky();
    const model = withBackup({ primary: main, backup: port("backup", answer("from the backup")), backupName: "b", backupSeesPictures: true });

    await model.complete(request);
    await model.complete(request);

    expect(main.calls).toHaveLength(2);
  });

  it("keeps one turn's hold apart from another's", async () => {
    const main = flaky();
    const model = withBackup({ primary: main, backup: port("backup", answer("from the backup")), backupName: "b", backupSeesPictures: true });

    await model.complete({ ...request, turnId: "room" });
    await model.complete({ ...request, turnId: "dm" });
    main.down = false;
    // The room's turn stays on the backup; a third turn tries the main model.
    expect((await model.complete({ ...request, turnId: "room" })).servedBy).toBe("b");
    expect((await model.complete({ ...request, turnId: "wake" })).servedBy).toBeUndefined();
    expect(main.calls).toHaveLength(3);
  });
});

describe("why the backup answered", () => {
  it("carries the main model's own error with the backup's answer", async () => {
    const main = port("main", new ModelError("no reply from the model service within 120000 ms", "timeout", 1));
    const model = withBackup({ primary: main, backup: port("backup", answer("ok")), backupName: "backup-model", backupSeesPictures: true });

    const reply = await model.complete(request);

    expect(reply.mainError).toBe("no reply from the model service within 120000 ms");
  });

  it("names each failed model in a chain, in order", async () => {
    const second = withBackup({
      primary: port("second", new ModelError("second is out of credit", "out_of_credit", 1)),
      backup: port("third", answer("from the third")),
      backupName: "third-model",
      backupSeesPictures: true,
    });
    const model = withBackup({
      primary: port("main", new ModelError("main is rate limited", "rate_limit", 4)),
      backup: second,
      backupName: "second-model",
      backupSeesPictures: true,
    });

    const reply = await model.complete(request);

    expect(reply).toMatchObject({ content: "from the third", servedBy: "third-model" });
    expect(reply.mainError).toBe("main is rate limited; then second-model: second is out of credit");
  });
});

describe("estimateTokens", () => {
  it("counts characters over 4, the context's own rough size, plus the output allowance", () => {
    expect(estimateTokens({ messages: [{ role: "user", content: "x".repeat(40) }] })).toBe(10);
    expect(estimateTokens({ messages: [{ role: "user", content: "x".repeat(40) }], maxOutputTokens: 5 })).toBe(15);
  });
});

describe("withoutPictures", () => {
  it("leaves a message with no pictures as it is, and a picture-only message keeps a plain line", () => {
    const plain: ModelRequest = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] };
    expect(withoutPictures(plain)).toEqual(plain);

    const onlyPicture: ModelRequest = { messages: [{ role: "user", content: "", images: [PICTURE, PICTURE] }] };
    expect(withoutPictures(onlyPicture).messages).toEqual([
      { role: "user", content: `${PICTURE_STAND_IN}\n${PICTURE_STAND_IN}` },
    ]);
  });
});

describe("the backup's routing", () => {
  it("says the main model takes a new turn's calls, even after a failed turn, with the backup's effort", async () => {
    const main: ModelPort = {
      info: { id: "fake:main", contextTokens: 8000, nativeTools: true },
      async complete(): Promise<ModelResponse> {
        throw new ModelError("service is down", "unavailable", 4);
      },
    };
    const model = withBackup({
      primary: main,
      backup: port("backup", answer("from the backup")),
      backupName: "backup-model",
      backupSeesPictures: true,
      backupEffort: "low",
    });
    expect(model.routing?.()).toEqual({ onBackup: false, backup: "backup-model", backupEffort: "low" });

    await model.complete({ ...request, turnId: "turn-1" });
    expect(model.routing?.()).toEqual({ onBackup: false, backup: "backup-model", backupEffort: "low" });
  });

  it("leaves the backup's effort out when the backup has none of its own", () => {
    const model = withBackup({
      primary: port("main", answer("from the main")),
      backup: port("backup", answer("from the backup")),
      backupName: "backup-model",
      backupSeesPictures: true,
    });
    expect(model.routing?.()).toEqual({ onBackup: false, backup: "backup-model" });
    expect(model.routing?.()).not.toHaveProperty("backupEffort");
  });
});

describe("quota windows through the backup", () => {
  it("when both models are out, the error carries the earlier of the two resets", async () => {
    const main = port("main", new ModelError("main out", "out_of_credit", 1, { limit: "weekly", resetAtMs: 5_000 }));
    const spare = port("spare", new ModelError("spare out", "out_of_credit", 1, { limit: "weekly", resetAtMs: 3_000 }));
    const model = withBackup({ primary: main, backup: spare, backupName: "spare", backupSeesPictures: true });
    const err = await model.complete({ messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).quota).toEqual({ limit: "weekly", resetAtMs: 3_000 });
  });

  it("gives no reset when one model's reset is unknown", () => {
    expect(bothResets({ resetAtMs: 1 }, { limit: "monthly" })).toEqual({ limit: "monthly" });
    expect(bothResets(undefined, undefined)).toBeUndefined();
  });
});
