// A fake voice organ for tests: it speaks the protocol in organ/PROTOCOL.md, frames included, with no imports from
// src/. Run it with node. Flags: --die-after-ready, --never-ready, --protocol <n>, --stderr <line>.

const args = process.argv.slice(2);

function flagValue(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const dieAfterReady = args.includes("--die-after-ready");
const neverReady = args.includes("--never-ready");
const protocol = Number(flagValue("--protocol") ?? 1);
const stderrLine = flagValue("--stderr");

if (stderrLine !== undefined) process.stderr.write(`${stderrLine}\n`);

function writeFrame(header, body = Buffer.alloc(0), after) {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const frame = Buffer.alloc(8 + headerBytes.length + body.length);
  frame.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(frame, 4);
  frame.writeUInt32BE(body.length, 4 + headerBytes.length);
  frame.set(body, 8 + headerBytes.length);
  if (after === undefined) process.stdout.write(frame);
  else process.stdout.write(frame, after);
}

function handle(header, body) {
  switch (header.op) {
    case "ping":
      writeFrame({ op: "pong", id: header.id });
      break;
    case "echo":
      writeFrame({ op: "echo", id: header.id, header }, body);
      break;
    case "fail":
      writeFrame({ op: "error", id: header.id, for: "fail", error: "ValueError: asked to fail" });
      break;
    case "die":
      process.exit(3);
      break;
    case "hang":
      // Never answer.
      break;
    case "stray":
      writeFrame({ op: "pong", id: 999999 });
      break;
    case "garbage": {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(2147483647, 0);
      process.stdout.write(length);
      break;
    }
    default:
      writeFrame({ op: "error", id: header.id, for: header.op, error: `unknown op ${header.op}` });
      break;
  }
}

let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (buffered.length < 4) return;
    const headerLength = buffered.readUInt32BE(0);
    if (buffered.length < 8 + headerLength) return;
    const bodyLength = buffered.readUInt32BE(4 + headerLength);
    if (buffered.length < 8 + headerLength + bodyLength) return;
    const header = JSON.parse(buffered.subarray(4, 4 + headerLength).toString("utf8"));
    const body = buffered.subarray(8 + headerLength, 8 + headerLength + bodyLength);
    buffered = buffered.subarray(8 + headerLength + bodyLength);
    handle(header, body);
  }
});

process.stdin.on("end", () => process.exit(0));

if (!neverReady) {
  setTimeout(() => {
    writeFrame(
      {
        op: "ready",
        protocol,
        voices: ["F2", "M2"],
        sample_rate: 48000,
        frame_ms: 20,
        lookahead: 312,
        phonemizer: "4",
        stt: "fake",
      },
      Buffer.alloc(0),
      () => {
        if (dieAfterReady) process.exit(3);
      },
    );
  }, 10);
}
