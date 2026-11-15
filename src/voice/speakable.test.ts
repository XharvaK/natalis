import { describe, expect, it } from "vitest";
import { PAUSE_MS, createChunker, speakable, speechChunks, type ChunkEnd, type SpeechChunk } from "./speakable.js";

const speakableCases: Array<{ input: string; say: string; skipped: string[] }> = [
  { input: "Dr. Smith said hi.", say: "Dr. Smith said hi.", skipped: [] },
  {
    input: "See https://status.example.com/jobs/backup now",
    say: "See status dot example dot com now",
    skipped: ["a link, read as its site name"],
  },
  { input: "[the docs](https://example.com/x) are here", say: "the docs are here", skipped: [] },
  { input: "**Honestly**, it's _fine_ and `ls` works", say: "Honestly, it's fine and ls works", skipped: [] },
  { input: "Nice 😊", say: "Nice", skipped: ["an emoji"] },
  { input: "🎉🎉 yay", say: "yay", skipped: ["2 emoji"] },
  { input: "# Title", say: "Title", skipped: [] },
  { input: "> quoted line", say: "quoted line", skipped: [] },
  { input: "- first item", say: "first item", skipped: [] },
  { input: "3) third item", say: "third item", skipped: [] },
  { input: "😊", say: "", skipped: ["an emoji"] },
  { input: "https://www.example.org", say: "example dot org", skipped: ["a link, read as its site name"] },
  { input: "I'd say snake_case_name stays.", say: "I'd say snake_case_name stays.", skipped: [] },
];

describe("speakable", () => {
  it("keeps the words it can say and names each thing it left out", () => {
    for (const { input, say, skipped } of speakableCases) expect(speakable(input), JSON.stringify(input)).toEqual({ say, skipped });
  });

  it("has the pause for every kind of end", () => {
    expect(PAUSE_MS).toEqual({ ".": 300, "!": 320, "?": 340, "…": 420, clause: 150, newline: 380, final: 0 });
  });
});

type Summary = [ChunkEnd, number, string, string[]];

function streamed(text: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  const chunker = createChunker({ onChunk: (chunk) => chunks.push(chunk) });
  for (let i = 0; i < text.length; i += 3) chunker.push(text.slice(i, i + 3));
  chunker.finish();
  return chunks;
}

function summary(chunks: SpeechChunk[]): Summary[] {
  return chunks.map((chunk): Summary => [chunk.end, chunk.pauseMs, chunk.say, chunk.skipped]);
}

const longText =
  "Oh, nice, you're back! \u{1F60A} So, about the server: the backup took 12.5 minutes last night, which is about twice the usual. " +
  "I checked the logs at https://status.example.com/jobs/backup and nothing looked wrong. **Honestly**, I'd just keep an eye on it tonight.\n\n" +
  "```bash\njournalctl --user -u backup\n```\nIf it happens again, I can look into it tomorrow at 9:30. Dr. Smith said \"fine\" — e.g. later.\n- first item\n- second item";

const chunkCases: Array<{ text: string; expected: Summary[] }> = [
  {
    text: "It took 12.5 minutes. Then e.g. later we go.",
    expected: [
      [".", 300, "It took 12.5 minutes.", []],
      [".", 300, "Then e.g. later we go.", []],
    ],
  },
  {
    text: "Wait... really? Yes! Okay.",
    expected: [
      ["…", 420, "Wait...", []],
      ["?", 340, "really?", []],
      ["!", 320, "Yes!", []],
      [".", 300, "Okay.", []],
    ],
  },
  {
    text: "```\nunclosed code\nmore ",
    expected: [["final", 0, "", ["a code block that never closed"]]],
  },
  {
    text: "one two three four five six seven eight nine ten eleven, twelve thirteen fourteen.",
    expected: [
      ["clause", 150, "one two three four five six seven eight nine ten eleven,", []],
      [".", 300, "twelve thirteen fourteen.", []],
    ],
  },
  {
    text: longText,
    expected: [
      ["!", 320, "Oh, nice, you're back!", []],
      [
        ".",
        300,
        "So, about the server: the backup took 12.5 minutes last night, which is about twice the usual.",
        ["an emoji"],
      ],
      [".", 300, "I checked the logs at status dot example dot com and nothing looked wrong.", ["a link, read as its site name"]],
      [".", 300, "Honestly, I'd just keep an eye on it tonight.", []],
      ["newline", 0, "", ["a code block (1 line)"]],
      [".", 300, "If it happens again, I can look into it tomorrow at 9:30.", []],
      [".", 300, 'Dr. Smith said "fine" — e.g. later.', []],
      ["newline", 380, "first item", []],
      ["final", 0, "second item", []],
    ],
  },
];

describe("createChunker", () => {
  it("agrees with speechChunks, whether the text comes whole or three characters at a time", () => {
    for (const { text, expected } of chunkCases) {
      expect(summary(speechChunks(text)), JSON.stringify(text)).toEqual(expected);
      expect(summary(streamed(text)), JSON.stringify(text)).toEqual(expected);
    }
  });
});
