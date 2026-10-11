// The replay gate: capture a window of an entity's life, replay its inputs on a copy (optionally with another
// model or config), and judge the two sides against a rubric. See docs/replay.md.

export { captureWindow, worldOf } from "./capture.js";
export type { CaptureOptions, CaptureResult } from "./capture.js";
export { copyForReplay, cutRiver } from "./copy.js";
export { readEventFile, readSayFile, writeJsonLines } from "./files.js";
export type { CapturedEvent, SayLine } from "./files.js";
export { judgeFiles, loadJudgeConfig, parseRubric, parseVerdict, renderReportMarkdown, runJudge, saysIn, windowOf } from "./judge.js";
export type { EventJudgement, JudgeInput, JudgeReport } from "./judge.js";
export { runReplay } from "./run.js";
export type { ReplayOptions, ReplayResult } from "./run.js";
export { replayModel } from "./model.js";
export { ReplayRecorder, ReplayWorld } from "./world.js";
