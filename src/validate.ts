// ============================================================================
// Tool-argument validation: a JSON Schema subset with stable, legacy-compatible messages
// ============================================================================
//
// Supported keywords: type (string, number, integer, boolean, array, object), enum, required, items,
// properties, additionalProperties: false, minLength/maxLength, pattern, minimum/maximum, exclusiveMinimum, maxItems.
// Anything else (description, minItems, ...) is ignored. Messages name the full path of the field,
// e.g. "visibility.github.repo" or "messages[0].role".
//
// Legacy rules, kept byte-identical because callers and tests depend on them:
// - "number" means a finite number ("must be a finite number").
// - An array whose items are absent or strings is an array of non-blank strings ("must be an array
//   of non-empty strings"); the empty array is allowed.
// - undefined and null both count as "not given": they are never type-checked.
//
// Extensions (stripped from schemas before they are listed over MCP):
// - "x-hint": text appended to the field's required and constraint messages, never to type messages.
// - "x-advisory-enum": true when the enum is listed for clients only, because the engine rejects
//   unknown values with its own established message (provider, mode).
// - "x-nonblank": true on a required string whose engine already refused whitespace-only values: such a
//   value is reported as missing. Elsewhere a required string is present as soon as it is a string,
//   so "" stays a valid message content or nudge.

export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  enum?: readonly unknown[];
  required?: readonly string[];
  items?: JsonSchema;
  properties?: Readonly<Record<string, JsonSchema>>;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  "x-hint"?: string;
  "x-advisory-enum"?: boolean;
  "x-nonblank"?: boolean;
  [keyword: string]: unknown;
}

/**
 * "values": every given value (types, enums, constraints, nested objects including their required
 * fields, unknown keys). "required": the top-level required fields. Tools run them in that order with
 * cross-field checks in between, so a bad provider is reported before a missing field.
 */
export type ValidationPhase = "values" | "required";

const ALL_PHASES: readonly ValidationPhase[] = ["values", "required"];

type Bag = Record<string, unknown>;

function isPlainObject(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own properties only: argument objects come from JSON, and "constructor" is not an argument. */
function own(obj: Bag, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function fail(path: string, rest: string, hint?: string): string {
  return `"${path}" ${rest}${hint ? `: ${hint}` : ""}`;
}

/** Arrays without object items keep the legacy meaning: non-blank strings. */
function isStringArray(schema: JsonSchema): boolean {
  return !schema.items || schema.items.type === undefined || schema.items.type === "string";
}

function isMissing(schema: JsonSchema | undefined, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return schema?.["x-nonblank"] === true && typeof value === "string" && !value.trim();
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function typeProblem(schema: JsonSchema, value: unknown, path: string): string | null {
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? null : fail(path, "must be a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : fail(path, "must be a finite number");
    case "integer":
      return Number.isSafeInteger(value) ? null : fail(path, "must be an integer");
    case "boolean":
      return typeof value === "boolean" ? null : fail(path, "must be a boolean");
    case "array":
      if (isStringArray(schema)) {
        const ok = Array.isArray(value) && Array.from(value).every((item) => typeof item === "string" && item.trim().length > 0);
        return ok ? null : fail(path, "must be an array of non-empty strings");
      }
      return Array.isArray(value) ? null : fail(path, "must be an array");
    case "object":
      return isPlainObject(value) ? null : fail(path, "must be an object");
    default:
      return null;
  }
}

function constraintProblem(schema: JsonSchema, value: unknown, path: string): string | null {
  const hint = schema["x-hint"];
  if (schema.enum && !schema["x-advisory-enum"] && !schema.enum.includes(value)) {
    return fail(path, `must be one of: ${schema.enum.map(String).join(", ")}`, hint);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return fail(path, `must be at least ${count(schema.minLength, "character")}`, hint);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return fail(path, `must be at most ${count(schema.maxLength, "character")}`, hint);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      return fail(path, `must match the pattern ${schema.pattern}`, hint);
    }
  }
  if (typeof value === "number") {
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return fail(path, `must be greater than ${schema.exclusiveMinimum}`, hint);
    if (schema.minimum !== undefined && value < schema.minimum) return fail(path, `must be at least ${schema.minimum}`, hint);
    if (schema.maximum !== undefined && value > schema.maximum) return fail(path, `must be at most ${schema.maximum}`, hint);
  }
  if (Array.isArray(value) && schema.maxItems !== undefined && value.length > schema.maxItems) {
    return fail(path, `must have at most ${count(schema.maxItems, "item")}`, hint);
  }
  return null;
}

function requiredProblem(schema: JsonSchema, obj: Bag, path: string): string | null {
  for (const key of schema.required ?? []) {
    const sub = schema.properties?.[key];
    if (isMissing(sub, own(obj, key))) return fail(childPath(path, key), "is required", sub?.["x-hint"]);
  }
  return null;
}

function objectProblem(schema: JsonSchema, obj: Bag, path: string, checkRequired: boolean): string | null {
  const properties = schema.properties ?? {};
  for (const [key, sub] of Object.entries(properties)) {
    const value = own(obj, key);
    if (value === undefined || value === null) continue;
    // An x-nonblank required string that is blank is reported as missing (by the required check), not as too short.
    if (schema.required?.includes(key) && isMissing(sub, value)) continue;
    const problem = valueProblem(sub, value, childPath(path, key));
    if (problem) return problem;
  }
  if (schema.additionalProperties === false) {
    const known = Object.keys(properties);
    for (const key of Object.keys(obj)) {
      if (!Object.hasOwn(properties, key)) {
        return fail(childPath(path, key), `is not allowed${known.length ? ` (expected: ${known.join(", ")})` : ""}`);
      }
    }
  }
  return checkRequired ? requiredProblem(schema, obj, path) : null;
}

/** A given value (never undefined or null at an object property; array items are checked as they are). */
function valueProblem(schema: JsonSchema, value: unknown, path: string): string | null {
  const problem = typeProblem(schema, value, path) ?? constraintProblem(schema, value, path);
  if (problem) return problem;
  if (Array.isArray(value) && schema.items) {
    for (const [i, item] of Array.from(value).entries()) {
      const itemProblem = valueProblem(schema.items, item, `${path}[${i}]`);
      if (itemProblem) return itemProblem;
    }
  }
  if (isPlainObject(value) && (schema.type === "object" || schema.properties)) {
    return objectProblem(schema, value, path, true);
  }
  return null;
}

/**
 * The first problem with `args` against an object schema, as `"field" must be ...`, or null.
 * Missing args count as {}. Phases run in the order given.
 */
export function findProblem(
  schema: JsonSchema,
  args: unknown,
  phases: readonly ValidationPhase[] = ALL_PHASES
): string | null {
  if (args !== undefined && args !== null && !isPlainObject(args)) return "arguments must be an object";
  const obj = (args ?? {}) as Bag;
  for (const phase of phases) {
    const problem = phase === "values" ? objectProblem(schema, obj, "", false) : requiredProblem(schema, obj, "");
    if (problem) return problem;
  }
  return null;
}

/** Throw `<label>: <problem>` for the first problem found. */
export function assertValid(
  label: string,
  schema: JsonSchema,
  args: unknown,
  phases: readonly ValidationPhase[] = ALL_PHASES
): void {
  const problem = findProblem(schema, args, phases);
  if (problem) throw new Error(`${label}: ${problem}`);
}

/** A deep copy without "x-" extension keywords (field names under properties are kept): what clients see over MCP. */
export function publicSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => publicSchema(item)) as T;
  if (!isPlainObject(schema)) return schema;
  const out: Bag = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-")) continue;
    out[key] = key === "properties" && isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, publicSchema(sub)]))
      : publicSchema(value);
  }
  return out as T;
}
