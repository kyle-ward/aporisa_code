// view_image, after codex (core/src/tools/handlers/view_image_spec.rs): a local PNG or
// JPEG goes back to the model as an input_image in the tool result. The client neither
// converts nor scales; the backend sizes images per `detail` (protocol section 7.1).
import { resolve } from "../paths.ts";
import { ToolError, type ToolHandler } from "./types.ts";

/** Files above this are refused; well under the backend's 64 MiB request body. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

export function imageMediaType(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  const startsWith = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(PNG)) return "image/png";
  if (startsWith(JPEG)) return "image/jpeg";
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export const viewImageTool: ToolHandler = {
  spec: {
    type: "function",
    name: "view_image",
    description:
      "View a local image file (PNG or JPEG) when visual inspection is needed, for example a screenshot or a rendered chart. Use this for images already on disk.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the image file, relative to the working directory or absolute." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  parallel: true,

  async run(args, context) {
    const display = args.path as string;
    const path = resolve(context.cwd, display);
    const bytes = await context.host.fs.readFile(path, { maxBytes: MAX_IMAGE_BYTES });
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new ToolError(`${display} is not a PNG or JPEG image; only those two formats can be viewed. Convert it first (for example with sips) if needed.`);
    return {
      output: [{ type: "input_image", image_url: `data:${mediaType};base64,${toBase64(bytes)}`, detail: "auto" }],
      success: true,
      details: { kind: "image", path: display },
    };
  },
};
