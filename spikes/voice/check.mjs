// Quick checks of the pure pieces, no Python: the streaming reader under random splits, and the chunker's output.
import { createArgsReader } from "./say-stream.mjs";
import { createChunker } from "./speech-text.mjs";

const text =
  "Oh, nice, you're back! \u{1F60A} So, about the server: the backup took 12.5 minutes last night, which is about twice the usual. " +
  "I checked the logs at https://status.example.com/jobs/backup and nothing looked wrong. **Honestly**, I'd just keep an eye on it tonight.\n\n" +
  "```bash\njournalctl --user -u backup\n```\nIf it happens again, I can look into it tomorrow at 9:30. Dr. Smith said \"fine\" — e.g. later.\n- first item\n- second item";
const json = JSON.stringify({ place: "voice:x", reply_to: null, attach: ["a", "b{"], text, knowingly: true }).replace(/\u{1F60A}/u, "\\ud83d\\ude0a");

let bad = 0;
for (let seed = 1; seed < 300; seed += 1) {
  let got = "";
  let place = "";
  let s = seed;
  const r = createArgsReader((k, f) => { if (k === "text") got += f; if (k === "place") place += f; });
  for (let i = 0; i < json.length;) { s = (s * 1103515245 + 12345) >>> 0; const n = 1 + (s % 7); r.push(json.slice(i, i + n)); i += n; }
  if (got !== text || place !== "voice:x" || !r.closed) bad += 1;
}
console.log("reader mismatches over 299 random splits:", bad);

const chunks = [];
const c = createChunker({ onChunk: (x) => chunks.push(x) });
for (let i = 0; i < text.length; i += 3) c.push(text.slice(i, i + 3));
c.finish();
for (const x of chunks) console.log(JSON.stringify([x.end, x.pauseMs, x.say, x.skipped]));
