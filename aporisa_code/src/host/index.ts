// Host layer: the harness's only access to the file system and processes. F2 runs
// commands unsandboxed (CLI asks before each one, DEVELOPMENT_PLAN.md FD-07); F3 adds
// Seatbelt sandboxing here.
export * from "./errors.ts";
export * from "./types.ts";
export { HeadTailBuffer, type HeadTailSnapshot } from "./head-tail-buffer.ts";
export { EXEC_ENV, NodeProcessManager, omissionMarker, PROCESS_DEFAULTS } from "./process.ts";
export { NodeHost, type NodeHostOptions } from "./node-host.ts";
