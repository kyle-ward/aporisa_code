// Runtime checks for what the renderer sends: the main process validates every request's
// params (the renderer is the less trusted side) and every approval answer.
import { z } from "zod";
import type { ClientMethod } from "./types.ts";

const effort = z.enum(["none", "low", "medium", "high"]);
const threadSettings = z.strictObject({
  effort,
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  approval: z.enum(["untrusted", "on-request", "never"]),
  network: z.boolean(),
});
const empty = z.strictObject({});
const id = z.string().min(1).max(128);
const threadId = id;
const path = z.string().min(1).max(4096);
const dataImage = z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/, "images must be PNG or JPEG data URLs");

export const PARAMS: Record<ClientMethod, z.ZodType> = {
  initialize: empty,
  "settings/read": empty,
  "settings/update": z.strictObject({
    device: z.strictObject({ language: z.enum(["en", "zh-CN"]), appearance: z.enum(["system", "light", "dark"]) }).partial().optional(),
    newThread: threadSettings.extend({ effort: effort.nullable() }).partial().optional(),
    connection: z
      .strictObject({
        baseUrl: z.string().url().max(512).nullable(),
        apiKey: z.string().max(4096),
      })
      .partial()
      .optional(),
  }),
  "connection/test": empty,
  "model/list": empty,
  "project/list": empty,
  "project/create": z.strictObject({ main: path }),
  "project/update": z.strictObject({ projectId: id, name: z.string().trim().min(1).max(200).optional(), references: z.array(path).max(32).optional() }),
  "project/remove": z.strictObject({ projectId: id }),
  "thread/list": empty,
  "thread/start": z.strictObject({ projectId: id.nullable(), settings: threadSettings.partial().optional() }),
  "thread/delete": z.strictObject({ threadId }),
  "thread/resume": z.strictObject({ threadId }),
  "thread/settings/update": z.strictObject({ threadId, settings: threadSettings.partial() }),
  "thread/compact": z.strictObject({ threadId }),
  "turn/start": z.strictObject({ threadId, text: z.string().max(1_000_000), images: z.array(dataImage).max(16) }),
  "turn/interrupt": z.strictObject({ threadId }),
  "dialog/selectFolder": empty,
  "shell/reveal": z.strictObject({ path }),
};

export const APPROVAL_RESULT = z.strictObject({ decision: z.enum(["approved", "approved_for_session", "denied"]) });

export function isClientMethod(method: unknown): method is ClientMethod {
  return typeof method === "string" && Object.hasOwn(PARAMS, method);
}
