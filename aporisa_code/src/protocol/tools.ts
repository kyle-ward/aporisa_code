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

/**
 * Checks a JSON value against a schema inside the portable subset (§8.3) with the
 * structured-output reading of §8.4: objects are closed unless their schema says
 * `additionalProperties: true`. Returns null when the value conforms, otherwise a short
 * reason naming the offending path.
 */
export function schemaValueViolation(value: unknown, schema: unknown, path = "$"): string | null {
  if (!isPlainObject(schema)) return `${path}: schema is not an object`;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((branch) => schemaValueViolation(value, branch, path) === null)
      ? null
      : `${path}: matches no anyOf branch`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    return `${path}: not one of the enum values`;
  }
  switch (schema.type) {
    case "null":
      return value === null ? null : `${path}: expected null`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path}: expected a boolean`;
    case "string":
      return typeof value === "string" ? null : `${path}: expected a string`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path}: expected a number`;
    case "integer":
      return Number.isInteger(value) ? null : `${path}: expected an integer`;
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected an array`;
      for (const [index, element] of value.entries()) {
        const violation = schemaValueViolation(element, schema.items, `${path}[${index}]`);
        if (violation) return violation;
      }
      return null;
    }
    case "object": {
      if (!isPlainObject(value)) return `${path}: expected an object`;
      const properties = isPlainObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const name of required) {
        if (typeof name === "string" && !(name in value)) return `${path}: missing '${name}'`;
      }
      for (const [name, element] of Object.entries(value)) {
        if (name in properties) {
          const violation = schemaValueViolation(element, properties[name], `${path}.${name}`);
          if (violation) return violation;
        } else if (schema.additionalProperties !== true) {
          return `${path}: unexpected property '${name}'`;
        }
      }
      return null;
    }
    default:
      return `${path}: unsupported schema type`;
  }
}

/** A deterministic value satisfying `schema` (subset of §8.3): what the mock outputs. */
export function schemaInstance(schema: unknown): unknown {
  if (!isPlainObject(schema)) return null;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return schemaInstance(schema.anyOf[0]);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "boolean":
      return true;
    case "string":
      return "text";
    case "number":
      return 1.5;
    case "integer":
      return 1;
    case "array":
      return [schemaInstance(schema.items)];
    case "object": {
      const properties = isPlainObject(schema.properties) ? schema.properties : {};
      return Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, schemaInstance(child)]));
    }
    default:
      return null;
  }
}
