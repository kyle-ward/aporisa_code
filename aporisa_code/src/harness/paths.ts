// POSIX path arithmetic for the harness, which may not import node:path (macOS only).

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

/** Collapses `.`, `..` and repeated slashes; the result is absolute when the input is. */
export function normalize(path: string): string {
  const absolute = isAbsolute(path);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** Resolves `path` against the absolute directory `base`. */
export function resolve(base: string, path: string): string {
  return normalize(isAbsolute(path) ? path : `${base}/${path}`);
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  return index === 0 ? "/" : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
