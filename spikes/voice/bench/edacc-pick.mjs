// Pick up to 3 conversational rows (6 to 25 words) per non-native first language from EdAcc test, with audio URLs.
import { writeFileSync } from "node:fs";
const skip = /Mainstream US|Scottish|Nigerian|Indian English/i;
const per = {}; const keep = [];
const offsets = []; for (let o = 0; o < 9289; o += 300) offsets.push(o);
for (let i = 0; i < offsets.length; i += 1) {
  const res = await Promise.all(offsets.slice(i, i + 1).map(async (o) => {
    for (let t = 0; t < 4; t++) {
      const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=edinburghcstr/edacc&config=default&split=test&offset=${o}&length=100`);
      if (r.ok) return (await r.json()).rows ?? [];
      await new Promise((s) => setTimeout(s, 2000 * (t + 1)));
    }
    return [];
  }));
  for (const rows of res) for (const { row_idx, row } of rows) {
    if (skip.test(row.l1)) continue;
    const words = row.text.replace(/<[^>]*>/g, " ").trim().split(/\s+/).filter(Boolean).length;
    if (words < 6 || words > 25 || /\[|<|\(/.test(row.text)) continue;
    const k = row.l1; if ((per[k] ?? 0) >= 3) continue;
    if (keep.some((x) => x.speaker === row.speaker && per[k] >= 2)) continue;
    per[k] = (per[k] ?? 0) + 1;
    keep.push({ row_idx, speaker: row.speaker, l1: row.l1, accent: row.raw_accent, text: row.text, url: row.audio?.[0]?.src });
  }
}
writeFileSync("edacc-pick.json", JSON.stringify(keep, null, 1));
console.log(keep.length, per);
