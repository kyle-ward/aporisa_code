// Minimal server-sent events decoder for docs/protocol.md §3.2: each event has an
// `event:` line and a single JSON `data:` line whose `type` matches. Comments are keepalives.
import { AporisaProtocolError } from "./errors.ts";

export interface SseMessage {
  event: string;
  data: string;
}

export async function* decodeSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event: string | null = null;
  const data: string[] = [];

  const dispatch = (): SseMessage | null => {
    if (event === null && data.length === 0) return null;
    if (event === null || data.length === 0) throw new AporisaProtocolError("SSE event is missing event or data");
    const message = { event, data: data.join("\n") };
    event = null;
    data.length = 0;
    return message;
  };

  const handleLine = (line: string): SseMessage | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else throw new AporisaProtocolError(`unexpected SSE field '${field}'`);
    return null;
  };

  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.search(/\r\n|\n|\r/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        const width = buffer.startsWith("\r\n", newline) ? 2 : 1;
        buffer = buffer.slice(newline + width);
        const message = handleLine(line);
        if (message) yield message;
        newline = buffer.search(/\r\n|\n|\r/);
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new AporisaProtocolError("SSE stream is not valid UTF-8");
    throw error;
  }
  if (buffer !== "" || event !== null || data.length > 0) {
    throw new AporisaProtocolError("SSE stream ended inside an event");
  }
}

/** Parses an SSE message into its JSON payload, checking that `type` matches `event:`. */
export function sseToJson(message: SseMessage): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(message.data);
  } catch {
    throw new AporisaProtocolError("SSE data is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || (payload as { type?: unknown }).type !== message.event) {
    throw new AporisaProtocolError("SSE event name does not match payload type");
  }
  return payload;
}
