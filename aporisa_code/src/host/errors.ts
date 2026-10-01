// Errors raised by the host layer. Messages may name the path involved (the model needs
// it to recover) but never include file contents or command output.

export type HostErrorCode =
  | "not_found"
  | "permission_denied"
  | "is_directory"
  | "not_a_directory"
  | "too_large"
  | "invalid_path"
  | "limit_exceeded"
  | "process_exited"
  | "busy"
  | "io_error";

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostError";
    this.code = code;
  }
}

const ERRNO_CODES: Record<string, HostErrorCode> = {
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EISDIR: "is_directory",
  ENOTDIR: "not_a_directory",
};

/** Maps a Node errno error to a HostError naming the operation and path. */
export function fromNodeError(error: unknown, operation: string, path: string): HostError {
  const errno = (error as { code?: unknown } | null)?.code;
  const code = (typeof errno === "string" && ERRNO_CODES[errno]) || "io_error";
  const reason = typeof errno === "string" ? errno : "unknown error";
  return new HostError(code, `${operation} failed for ${path}: ${reason}`, { cause: error });
}
