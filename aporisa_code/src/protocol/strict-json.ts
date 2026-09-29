// Strict JSON parsing (docs/protocol.md §3.1): JSON.parse silently keeps the last
// duplicate key, so the grammar is re-implemented here to reject duplicates.

export class StrictJsonError extends Error {
  override readonly name = "StrictJsonError";
}

const MAX_DEPTH = 256;

export function parseStrictJson(text: string): unknown {
  const parser = new Parser(text);
  parser.skipWhitespace();
  const value = parser.parseValue(0);
  parser.skipWhitespace();
  if (!parser.atEnd()) throw new StrictJsonError("unexpected trailing characters");
  return value;
}

class Parser {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd()) {
      const char = this.text[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") this.index += 1;
      else break;
    }
  }

  parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new StrictJsonError("JSON is nested too deeply");
    const char = this.text[this.index];
    switch (char) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.parseNumber();
        throw new StrictJsonError("unexpected character");
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { ...result };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') throw new StrictJsonError("expected object key");
      const key = this.parseString();
      if (seen.has(key)) throw new StrictJsonError("duplicate object key");
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") throw new StrictJsonError("expected ':'");
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === "}") return { ...result };
      if (next !== ",") throw new StrictJsonError("expected ',' or '}'");
    }
  }

  private parseArray(depth: number): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === "]") return result;
      if (next !== ",") throw new StrictJsonError("expected ',' or ']'");
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) throw new StrictJsonError("unterminated string");
      if (char === '"') break;
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      if (char < " ") throw new StrictJsonError("control character in string");
      this.index += 1;
    }
    this.index += 1;
    // Escapes are validated and decoded by JSON.parse on the isolated literal.
    try {
      return JSON.parse(this.text.slice(start, this.index)) as string;
    } catch {
      throw new StrictJsonError("invalid string escape");
    }
  }

  private parseNumber(): number {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new StrictJsonError("invalid number");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new StrictJsonError("number out of range");
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.index)) throw new StrictJsonError("invalid literal");
    this.index += literal.length;
    return value;
  }
}
