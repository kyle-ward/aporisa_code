// Tool specifications and the portable JSON Schema subset (docs/protocol.md §8).
import { z } from "zod";

const toolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const jsonObject = z.record(z.string(), z.unknown());

export const FunctionTool = z.strictObject({
  type: z.literal("function"),
  name: toolName,
  description: z.string().max(8192).optional(),
  parameters: jsonObject,
  strict: z.boolean().optional(),
});

export const CustomTool = z.strictObject({
  type: z.literal("custom"),
  name: toolName,
  description: z.string().max(8192).optional(),
  format: z.strictObject({ type: z.literal("text") }).optional(),
});

export const ToolSpec = z.discriminatedUnion("type", [FunctionTool, CustomTool]);

export type FunctionTool = z.infer<typeof FunctionTool>;
export type CustomTool = z.infer<typeof CustomTool>;
export type ToolSpec = z.infer<typeof ToolSpec>;

const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "description",
  "additionalProperties",
  "anyOf",
]);
const MAX_SCHEMA_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns null when `schema` stays inside the portable subset, otherwise a short
 * reason. The root must be an object schema; `anyOf` is rejected at the root.
 */
export function schemaSubsetViolation(schema: unknown): string | null {
  if (!isPlainObject(schema) || schema.type !== "object") {
    return "root schema must be an object schema";
  }
  return visit(schema, 0, true);
}

function visit(node: unknown, depth: number, isRoot: boolean): string | null {
  if (depth > MAX_SCHEMA_DEPTH) return "schema is nested too deeply";
  if (!isPlainObject(node)) return "every schema node must be an object";
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) return `keyword '${key}' is not supported`;
  }
  if ("anyOf" in node) {
    if (isRoot) return "anyOf is not allowed at the root";
    const branches = node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) return "anyOf must be a non-empty array";
    for (const key of Object.keys(node)) {
      if (key !== "anyOf" && key !== "description") return "anyOf cannot be mixed with other keywords";
    }
    for (const branch of branches) {
      const violation = visit(branch, depth + 1, false);
      if (violation) return violation;
    }
    return null;
  }
  const type = node.type;
  if (typeof type !== "string" || !SCHEMA_TYPES.has(type)) return "type must be a single supported type";
  if ("description" in node && typeof node.description !== "string") return "description must be a string";
  if ("enum" in node) {
    const values = node.enum;
    if (!Array.isArray(values) || values.length === 0) return "enum must be a non-empty array";
    if (!values.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))) {
      return "enum values must be scalars";
    }
  }
  if (type === "object") {
    const properties = node.properties ?? {};
    if (!isPlainObject(properties)) return "properties must be an object";
    for (const child of Object.values(properties)) {
      const violation = visit(child, depth + 1, false);
      if (violation) return violation;
    }
    if ("required" in node) {
      const required = node.required;
      if (!Array.isArray(required) || !required.every((name) => typeof name === "string" && name in properties)) {
        return "required must list declared properties";
      }
    }
    if ("additionalProperties" in node && typeof node.additionalProperties !== "boolean") {
      return "additionalProperties must be a boolean";
    }
  } else {
    for (const key of ["properties", "required", "additionalProperties"]) {
      if (key in node) return `'${key}' is only valid on object schemas`;
    }
  }
  if (type === "array") {
    if (!("items" in node)) return "array schemas must declare items";
    return visit(node.items, depth + 1, false);
  }
  if ("items" in node) return "'items' is only valid on array schemas";
  return null;
}
