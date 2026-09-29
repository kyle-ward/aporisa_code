// Aporisa SDK: interface C for the harness. Drivers: native (own backend) now;
// openrouter (compat) arrives in F2; the stub driver lives with the mock in src/mock.
export * from "./errors.ts";
export * from "./types.ts";
export { ResponseStream, type ResponseStreamSource } from "./response-stream.ts";
export { NativeDriver, type NativeDriverOptions, toCapabilities, estimateTokens } from "./drivers/native/index.ts";
