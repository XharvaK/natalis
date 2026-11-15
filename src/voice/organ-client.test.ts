import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createOrganSupervisor, type OrganSupervisor, OrganError, organCommand } from "./organ-client.js";

const FAKE_ORGAN = fileURLToPath(new URL("./testing/fake-organ.mjs", import.meta.url));
const supervisors: OrganSupervisor[] = [];

function makeSupervisor(
  args: string[] = [],
  options: Partial<Parameters<typeof createOrganSupervisor>[0]> = {},
): { supervisor: OrganSupervisor; lines: string[] } {
  const lines: string[] = [];
  const supervisor = createOrganSupervisor({
    command: process.execPath,
    args: [FAKE_ORGAN, ...args],
    restartDelaysMs: [50, 100, 200],
    log: (line) => lines.push(line),
    ...options,
  });
  supervisors.push(supervisor);
  supervisor.start();
  return { supervisor, lines };
}

async function waitFor(check: () => boolean, what: string, lines: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}. Logs:\n${lines.join("\n")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function starts(lines: string[]): number {
  return lines.filter((line) => line === "[voice organ] starting").length;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
});

describe("createOrganSupervisor", () => {
  it("starts, maps the ready frame, and answers ping and echo", async () => {
    const { supervisor } = makeSupervisor();
    const ready = await supervisor.whenReady();
    expect(ready).toEqual({
      protocol: 1,
      voices: ["F2", "M2"],
      sampleRate: 48000,
      frameMs: 20,
      lookahead: 312,
      phonemizer: "4",
      stt: "fake",
    });
    expect(supervisor.resting()).toBeUndefined();
    expect(supervisor.ready()).toEqual(ready);

    const pong = await supervisor.call({ op: "ping" });
    expect(pong.header).toMatchObject({ op: "pong" });

    const body = Uint8Array.from({ length: 100 * 1024 }, (_, i) => (i * 7) % 256);
    const echo = await supervisor.call({ op: "echo" }, body);
    expect(echo.header.op).toBe("echo");
    expect(Buffer.from(echo.body).equals(Buffer.from(body))).toBe(true);
  });

  it("rejects an error reply as failed and keeps taking calls", async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.whenReady();
    const error = await supervisor.call({ op: "fail" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OrganError);
    expect((error as OrganError).kind).toBe("failed");
    expect((error as OrganError).message).toBe("ValueError: asked to fail");

    const pong = await supervisor.call({ op: "ping" });
    expect(pong.header.op).toBe("pong");
  });

  it("rejects a call before ready without sending it", async () => {
    const { supervisor } = makeSupervisor();
    const error = await supervisor.call({ op: "ping" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OrganError);
    expect((error as OrganError).kind).toBe("resting");
    expect((error as OrganError).message).toBe("your voice organ is starting");

    await supervisor.whenReady();
    const echo = await supervisor.call({ op: "echo" });
    // Had the early call reached the organ it would have taken id 1.
    expect((echo.header.header as Record<string, unknown>).id).toBe(1);
  });

  it("rejects a call when the organ dies, then restarts and keeps ids rising", async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.whenReady();
    const first = await supervisor.call({ op: "echo" });
    const firstId = (first.header.header as Record<string, unknown>).id as number;

    const error = await supervisor.call({ op: "die" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OrganError);
    expect((error as OrganError).kind).toBe("stopped");
    expect((error as OrganError).message).toBe("the voice organ stopped (exit code 3) before it answered");
    expect(supervisor.resting()).toBe("your voice organ stopped (exit code 3) and starts again in 50 ms");

    await supervisor.whenReady();
    const second = await supervisor.call({ op: "echo" });
    expect((second.header.header as Record<string, unknown>).id as number).toBeGreaterThan(firstId);
  });

  it("backs off 50, 100, 200 and then 200 ms", async () => {
    const { lines } = makeSupervisor(["--die-after-ready"]);
    await waitFor(
      () => lines.filter((line) => line.includes("stopped (exit code 3); starting again in")).length >= 4,
      "four deaths",
      lines,
    );
    const stopped = lines.filter((line) => line.includes("stopped (exit code 3); starting again in"));
    expect(stopped[0]).toBe("[voice organ] stopped (exit code 3); starting again in 50 ms");
    expect(stopped[1]).toBe("[voice organ] stopped (exit code 3); starting again in 100 ms");
    expect(stopped[2]).toBe("[voice organ] stopped (exit code 3); starting again in 200 ms");
    expect(stopped[3]).toBe("[voice organ] stopped (exit code 3); starting again in 200 ms");
  });

  it("kills an organ that is not ready in time and starts it again", async () => {
    const { lines } = makeSupervisor(["--never-ready"], { readyTimeoutMs: 300 });
    await waitFor(
      () => lines.includes("[voice organ] not ready after 300 ms; stopping it"),
      "the ready timeout",
      lines,
    );
    await waitFor(() => starts(lines) >= 2, "a restart", lines);
  });

  it("treats garbage as a protocol fault and restarts", async () => {
    const { supervisor, lines } = makeSupervisor();
    await supervisor.whenReady();
    const rejected = supervisor.call({ op: "garbage" }).catch((reason: unknown) => reason);
    await waitFor(() => lines.some((line) => line.includes("broke the protocol")), "a protocol fault", lines);
    await waitFor(() => starts(lines) >= 2, "a restart", lines);
    expect(await rejected).toBeInstanceOf(OrganError);
  });

  it("treats a stray reply as a protocol fault and restarts", async () => {
    const { supervisor, lines } = makeSupervisor();
    await supervisor.whenReady();
    const rejected = supervisor.call({ op: "stray" }).catch((reason: unknown) => reason);
    await waitFor(() => lines.some((line) => line.includes("broke the protocol")), "a protocol fault", lines);
    await waitFor(() => starts(lines) >= 2, "a restart", lines);
    expect(await rejected).toBeInstanceOf(OrganError);
  });

  it("treats a wrong protocol version as a protocol fault and restarts", async () => {
    const { lines } = makeSupervisor(["--protocol", "2"]);
    await waitFor(() => lines.some((line) => line.includes("broke the protocol")), "a protocol fault", lines);
    await waitFor(() => starts(lines) >= 2, "a restart", lines);
  });

  it("rejects a call that times out and restarts the organ", async () => {
    const { supervisor, lines } = makeSupervisor();
    await supervisor.whenReady();
    const before = starts(lines);
    const error = await supervisor
      .call({ op: "hang" }, undefined, { timeoutMs: 300 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OrganError);
    expect((error as OrganError).kind).toBe("failed");
    expect((error as OrganError).message).toBe("the voice organ did not answer hang in 300 ms");

    await waitFor(() => starts(lines) > before, "a restart", lines);
    await supervisor.whenReady();
    const pong = await supervisor.call({ op: "ping" });
    expect(pong.header.op).toBe("pong");
  });

  it("stops while a call is in flight and never starts again", async () => {
    const { supervisor, lines } = makeSupervisor();
    await supervisor.whenReady();
    const rejected = supervisor.call({ op: "hang" }).catch((reason: unknown) => reason);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await supervisor.stop();
    const error = await rejected;
    expect(error).toBeInstanceOf(OrganError);
    expect((error as OrganError).kind).toBe("stopped");
    expect((error as OrganError).message).toBe("the voice organ stopped (it was stopped) before it answered");
    expect(supervisor.resting()).toBe("your voice organ is stopped");

    const before = starts(lines);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts(lines)).toBe(before);

    const readyError = await supervisor.whenReady().catch((reason: unknown) => reason);
    expect(readyError).toBeInstanceOf(OrganError);
    expect((readyError as OrganError).kind).toBe("stopped");
    expect((readyError as OrganError).message).toBe("your voice organ is stopped");
  });

  it("logs stderr but never puts it in resting text or errors", async () => {
    const { supervisor, lines } = makeSupervisor(["--stderr", "secret path /x/y"]);
    await supervisor.whenReady();
    await waitFor(() => lines.includes("[voice organ] secret path /x/y"), "the stderr line", lines);

    const error = await supervisor.call({ op: "die" }).catch((reason: unknown) => reason);
    expect((error as OrganError).message).not.toContain("secret path /x/y");
    expect(supervisor.resting() ?? "").not.toContain("secret path /x/y");
  });

  it("builds the organ command line", () => {
    expect(organCommand({ python: "/v/bin/python", models: "/m" }, "/s/voice_organ.py")).toEqual({
      command: "/v/bin/python",
      args: ["-I", "/s/voice_organ.py", "--models", "/m"],
    });
  });
});
