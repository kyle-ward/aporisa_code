// Canonical JSON helpers used for equality checks (continuation, stream consistency).

/** Deterministic JSON: object keys sorted, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, member]) => [key, normalize(member)]));
  }
  return value;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Item equality that ignores `id`, which carries no semantics in requests (§7.1). */
export function itemsEqualIgnoringIds(a: unknown, b: unknown): boolean {
  return jsonEqual(stripId(a), stripId(b));
}

function stripId(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const { id: _id, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}
