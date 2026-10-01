// Host layer: the harness's only access to the file system and processes. It runs
// commands under the macOS Seatbelt sandbox when the request carries a SandboxSpec (F3).
export * from "./errors.ts";
export * from "./types.ts";
export { HeadTailBuffer, type HeadTailSnapshot } from "./head-tail-buffer.ts";
export { commandEnvironment, EXEC_ENV, NodeProcessManager, omissionMarker, PROCESS_DEFAULTS } from "./process.ts";
export { regexLiteral, SANDBOX_EXEC, seatbeltArgs, seatbeltPolicy, type SeatbeltInvocation } from "./sandbox/seatbelt.ts";
export { NodeHost, type NodeHostOptions } from "./node-host.ts";
