#!/bin/sh
# All STT benches, one at a time, one thread each, low priority, headless. Results: results.jsonl. Never plays audio.
cd "$(dirname "$0")"
: > results.jsonl
for m in moonshine-tiny moonshine-base parakeet-110m kroko-streaming whisper-base.en; do
  echo "start $m $(date +%T)" >> run_all.log
  nice -n 10 venv/bin/python stt_bench.py "$m" >> results.jsonl 2>> run_all.log
done
for m in tiny small medium; do
  echo "start moonshine-$m-streaming $(date +%T)" >> run_all.log
  nice -n 10 venv/bin/python moonshine_bench.py "$m" >> results.jsonl 2>> run_all.log
done
echo "start vad $(date +%T)" >> run_all.log
nice -n 10 venv/bin/python vad_bench.py >> results.jsonl 2>> run_all.log
echo "done $(date +%T)" >> run_all.log
