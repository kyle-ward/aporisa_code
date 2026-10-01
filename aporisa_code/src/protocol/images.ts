// input_image checks shared by servers and clients (docs/protocol.md §7.1, §11).
// A server decodes images fully; this is the structural part every side can check without
// an image library: the declared format matches the bytes, the header gives a size, and
// the file is complete. Runs in Node and in a browser (atob, no Buffer).
import type { InputItem } from "./items.ts";

export interface ImageInfo {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

const DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]; // "IEND" and its CRC
// JPEG start-of-frame markers (baseline, progressive, lossless, arithmetic); not DHT/JPG/DAC.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

const u16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u32 = (bytes: Uint8Array, at: number) => u16(bytes, at) * 0x10000 + u16(bytes, at + 2);

function png(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 33 + 12 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  // The first chunk is IHDR (length 13); the last is IEND.
  if (u32(bytes, 8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  if (PNG_END.some((value, index) => bytes[bytes.length - 8 + index] !== value)) return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  return width > 0 && height > 0 ? { format: "png", width, height } : null;
}

function jpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (JPEG_FRAMES.has(marker)) {
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      return width > 0 && height > 0 ? { format: "jpeg", width, height } : null;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // image data before any frame header
    at += 2 + u16(bytes, at + 2);
  }
  return null;
}

/** The image a data URL holds, or null when it is not a complete PNG or JPEG of the
 * declared format (§7.1 `invalid_image`). */
export function imageInfo(dataUrl: string): ImageInfo | null {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  const bytes = decodeBase64(match[2] ?? "");
  if (!bytes) return null;
  const info = match[1] === "png" ? png(bytes) : jpeg(bytes);
  return info !== null && info.format === match[1] ? info : null;
}

/** Every input_image of an input list, with the parameter path naming it. */
export function inputImages(input: readonly InputItem[]): { param: string; imageUrl: string }[] {
  const images: { param: string; imageUrl: string }[] = [];
  for (const [index, item] of input.entries()) {
    if (item.type === "message") {
      for (const [part, content] of item.content.entries()) {
        if (content.type === "input_image") images.push({ param: `input[${index}].content[${part}]`, imageUrl: content.image_url });
      }
    } else if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.output !== "string") {
      for (const [part, content] of item.output.entries()) {
        if (content.type === "input_image") images.push({ param: `input[${index}].output[${part}]`, imageUrl: content.image_url });
      }
    }
  }
  return images;
}
