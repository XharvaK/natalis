"""Build audio/sets.json: 20 LibriSpeech read utterances, accented conversational EdAcc clips, and tiny-voca F2 lines."""
import io, json, os, urllib.request
import pyarrow.parquet as pq
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "audio")
items = []

table = pq.read_table(os.path.join(A, "libri.parquet")).to_pylist()
for i, row in enumerate(table[:20]):
    audio, sr = sf.read(io.BytesIO(row["audio"]["bytes"]), dtype="float32")
    name = f"libri-{i:02d}.wav"
    sf.write(os.path.join(A, name), audio, sr)
    items.append({"file": name, "text": row["text"], "set": "libri-read"})

picks = os.path.join(A, "edacc-pick.json")
if os.path.exists(picks):
    for i, p in enumerate(json.load(open(picks))):
        name = f"edacc-{i:02d}.wav"
        path = os.path.join(A, name)
        if not os.path.exists(path):
            try:
                urllib.request.urlretrieve(p["url"], path)
            except Exception as e:  # an expired or refused link: leave the clip out
                print("skip", name, e)
                continue
        items.append({"file": name, "text": p["text"], "set": "edacc-accented", "l1": p["l1"]})

f2 = os.path.join(A, "f2.json")
if os.path.exists(f2):
    for it in json.load(open(f2)):
        items.append({"file": it["file"], "text": it["text"], "set": "f2-synthetic"})

json.dump(items, open(os.path.join(A, "sets.json"), "w"), indent=1)
print(len(items), {s: sum(1 for x in items if x["set"] == s) for s in {x["set"] for x in items}})
