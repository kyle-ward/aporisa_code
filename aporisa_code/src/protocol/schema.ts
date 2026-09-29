// Machine-readable contract export: the zod definitions in this directory are the single
// source; the generated JSON Schema is committed under docs/schema/ and checked for drift.
import { z } from "zod";
import { ErrorBody, WsErrorMessage } from "./errors.ts";
import { ResponseObject, StreamEvent, Usage } from "./events.ts";
import { InputItem, OutputItem } from "./items.ts";
import { Model, ModelList } from "./models.ts";
import {
  HttpCreateRequest,
  InputTokensRequest,
  InputTokensResult,
  WsCreateMessage,
  WsInterruptMessage,
} from "./request.ts";
import { ToolSpec } from "./tools.ts";

export const PROTOCOL_VERSION = "v0";
export const SCHEMA_RELATIVE_PATH = "../docs/schema/aporisa-protocol-v0.schema.json";

const EXPORTED = {
  InputItem,
  OutputItem,
  ToolSpec,
  Model,
  ModelList,
  HttpCreateRequest,
  WsCreateMessage,
  WsInterruptMessage,
  InputTokensRequest,
  InputTokensResult,
  Usage,
  ResponseObject,
  StreamEvent,
  ErrorBody,
  WsErrorMessage,
} as const;

export function buildProtocolSchema(): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(EXPORTED)) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
    defs[name] = rest;
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://aporisa.local/protocol/${PROTOCOL_VERSION}`,
    title: `Aporisa protocol ${PROTOCOL_VERSION}`,
    description:
      "Generated from aporisa_code/src/protocol. Do not edit by hand; see docs/protocol.md §13. " +
      "Cross-field rules (refinements, §6 structure rules, §7.3 ordering) are not expressible here.",
    $defs: defs,
  };
}

export function renderProtocolSchema(): string {
  return `${JSON.stringify(buildProtocolSchema(), null, 2)}\n`;
}
