/**
 * zod → ArgSpec: declare an endpoint's input contract ONCE, as a zod object
 * schema, and get both the describe face (the ArgSpecs the host engine
 * routes named arguments by) and dispatch-time validation from it. TS types
 * are erased at runtime; zod is the runtime carrier of the same facts.
 *
 * ```ts
 * import { z } from "zod";
 * import { endpoint } from "@ikigai/wire/zod";
 *
 * const hello = endpoint("urn:ts:hello", {
 *   summary: "Greet someone",
 *   input: z.object({
 *     who: z.string().describe("the name to greet"),
 *     greeting: z.string().default("Hello"),
 *     mode: z.enum(["loud", "soft"]).optional(),
 *   }),
 * }, ({ who, greeting, mode }) => `${greeting}, ${who}!${mode === "loud" ? "!" : ""}`);
 * ```
 *
 * The derivation (via zod's own JSON Schema face, `z.toJSONSchema` with
 * `io: "input"`, so it tracks zod's semantics rather than its internals):
 *
 * | zod                    | ArgSpec                                    |
 * | ---------------------- | ------------------------------------------ |
 * | `z.string()`           | `class` = xsd:string                       |
 * | `z.number()`           | `class` = xsd:double                       |
 * | `z.number().int()`     | `class` = xsd:integer                      |
 * | `z.boolean()`          | `class` = xsd:boolean                      |
 * | `z.enum([...])`        | `one_of` (strings only), xsd:string        |
 * | `.default(v)`          | optional + `default` (its wire text form)  |
 * | `.optional()`          | optional                                   |
 * | `.describe("…")`       | the per-argument `summary`                 |
 *
 * Anything else (arrays, nested objects, unions, …) throws at declaration
 * time: wire arguments are named text values, and an ArgSpec that cannot
 * say what it takes would make the manifold lie.
 *
 * The SAME schema validates at dispatch, before the handler runs: wire text
 * is coerced by the declared type (`"3.5"` → 3.5, `"true"` → true), parsed
 * by zod, and the handler receives the TYPED output (`z.output<S>`) —
 * defaults applied, numbers as numbers, no `String(x)` coercion in handler
 * bodies. Bad input is a typed `InvalidArgument` naming the field — since
 * wire v7 it crosses to the host AS that variant (an HTTP face can answer
 * 400, not a blanket 502).
 *
 * This module is deliberately NOT re-exported from `mod.ts`: zod is a peer
 * dependency of this file alone, resolved only when `@ikigai/wire/zod` is
 * imported. `src/` without it stays zero-dependency for consumers who
 * declare `args:` explicitly.
 *
 * The explicit `args:` form keeps working unchanged. When BOTH `args:` and
 * `input:` are given, the explicit specs are used for the describe face —
 * but only after they are checked against the derivation, loudly: a face
 * that disagrees with the schema that validates at dispatch would over- or
 * under-offer. (An explicit spec may carry a richer `summary`, and may omit
 * `class` — less information is tolerated, contradiction is not.)
 */

import { z } from "zod";
import {
  ArgSpec,
  type ArgSpecInput,
  EndpointDef,
  type EndpointOptions,
  type Handler,
  type HandlerResult,
} from "./serve.ts";
import { InvalidArgumentError } from "./wire.ts";

const XSD = "http://www.w3.org/2001/XMLSchema#";

/** {@linkcode EndpointOptions} plus the zod input contract. */
export interface ZodEndpointOptions<S extends z.ZodObject = z.ZodObject>
  extends EndpointOptions {
  /**
   * The input contract: a `z.object(...)` whose properties are the named
   * arguments. ArgSpecs derive from it; it validates every dispatch.
   */
  input: S;
}

/** A handler receiving the PARSED (typed, defaulted) arguments. */
export type ZodHandler<S extends z.ZodObject> = (
  args: z.output<S>,
) => HandlerResult | Promise<HandlerResult>;

/** What the dispatch-time coercion needs to know per argument. */
interface PropInfo {
  /** The JSON Schema type: string | number | integer | boolean. */
  type: string;
}

/** The slice of a JSON Schema property this derivation reads. */
interface PropSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  default?: unknown;
}

interface Derivation {
  specs: ArgSpec[];
  props: Map<string, PropInfo>;
}

/**
 * Derive the ArgSpecs for a zod object schema — the same specs
 * {@linkcode endpoint} declares. Exported for inspection and tests.
 * Throws on any property that cannot be a named wire argument.
 */
export function argSpecsFromZod(input: z.ZodObject): ArgSpec[] {
  return derive(input).specs;
}

function derive(input: z.ZodObject): Derivation {
  const json = z.toJSONSchema(input, { io: "input" }) as {
    type?: string;
    properties?: Record<string, PropSchema>;
    required?: string[];
  };
  if (json.type !== "object") {
    throw new Error("the zod input contract must be a z.object(...)");
  }
  const required = new Set(json.required ?? []);
  const specs: ArgSpec[] = [];
  const props = new Map<string, PropInfo>();
  for (const [name, prop] of Object.entries(json.properties ?? {})) {
    let cls: string;
    let oneOf: string[] | undefined;
    if (prop.enum !== undefined) {
      if (!prop.enum.every((v): v is string => typeof v === "string")) {
        throw new Error(
          `cannot derive an ArgSpec for \`${name}\`: only string-valued ` +
            "enums map to one_of (wire arguments are text)",
        );
      }
      oneOf = prop.enum;
      cls = `${XSD}string`;
    } else {
      switch (prop.type) {
        case "string":
          cls = `${XSD}string`;
          break;
        case "number":
          cls = `${XSD}double`;
          break;
        case "integer":
          cls = `${XSD}integer`;
          break;
        case "boolean":
          cls = `${XSD}boolean`;
          break;
        default:
          throw new Error(
            `cannot derive an ArgSpec for \`${name}\`: unsupported schema ` +
              `(${
                prop.type ?? "no plain type"
              }) — wire arguments are named text ` +
              "values, so only string/number/boolean/enum properties derive",
          );
      }
    }
    const spec: ArgSpecInput = { name, class: cls };
    if (prop.description !== undefined) spec.summary = prop.description;
    if (prop.default !== undefined) {
      // The wire text form: what the engine would pass when the argument is
      // omitted ("true"/"3.5"/verbatim strings) — ArgSpec then marks the
      // argument optional, as the Rust side does.
      spec.default = typeof prop.default === "string"
        ? prop.default
        : String(prop.default);
    } else {
      spec.required = required.has(name);
    }
    if (oneOf !== undefined) spec.oneOf = oneOf;
    specs.push(new ArgSpec(spec));
    props.set(name, { type: oneOf !== undefined ? "string" : prop.type! });
  }
  return { specs, props };
}

/**
 * Coerce one wire argument (text) toward its declared type, so the zod
 * schema sees `3.5` rather than `"3.5"`. Unconvertible text passes through
 * untouched — zod then names the type mismatch, and the field.
 */
function coerceValue(
  name: string,
  value: string | Uint8Array,
  prop: PropInfo | undefined,
): unknown {
  if (value instanceof Uint8Array) {
    // Bytes arrive only when the argument was not valid utf-8; every
    // derivable schema type is textual, so name the problem plainly — and
    // typed, so it crosses the wire as a real InvalidArgument (v7).
    throw new InvalidArgumentError(name, "not valid UTF-8 text");
  }
  if (prop === undefined) return value;
  if (prop.type === "number" || prop.type === "integer") {
    const text = value.trim();
    if (text !== "") {
      const n = Number(text);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }
  if (prop.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  return value;
}

/**
 * A validation failure as a typed `InvalidArgument` (v7: it crosses the
 * wire as that variant, so the host — and an HTTP face — sees a real
 * 400-equivalent). The error names the FIRST failing field; when several
 * fields fail, the detail lists every issue, each naming its field.
 */
function invalidArguments(error: z.ZodError): InvalidArgumentError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.length === 0
      ? "(input)"
      : issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
  const detail = issues.length === 1
    ? issues[0].message
    : issues.map((i) => `\`${i.path}\`: ${i.message}`).join("; ");
  return new InvalidArgumentError(issues[0].path, detail);
}

/**
 * The loud mismatch check for the both-given case: the explicit face must
 * not contradict the schema that validates at dispatch.
 */
function assertSpecsMatch(
  iri: string,
  explicit: readonly ArgSpec[],
  derived: readonly ArgSpec[],
): void {
  const problems: string[] = [];
  const derivedByName = new Map(derived.map((s) => [s.name, s]));
  const explicitNames = new Set(explicit.map((s) => s.name));
  for (const d of derived) {
    if (!explicitNames.has(d.name)) {
      problems.push(`\`${d.name}\` is in the zod input but not in args`);
    }
  }
  for (const e of explicit) {
    const d = derivedByName.get(e.name);
    if (d === undefined) {
      problems.push(`\`${e.name}\` is in args but not in the zod input`);
      continue;
    }
    if (e.required !== d.required) {
      problems.push(
        `\`${e.name}\`: args says required=${e.required}, ` +
          `the zod input derives required=${d.required}`,
      );
    }
    if (e.cls !== null && e.cls !== d.cls) {
      problems.push(
        `\`${e.name}\`: args says class ${e.cls}, ` +
          `the zod input derives ${d.cls}`,
      );
    }
    if (e.default !== d.default) {
      problems.push(
        `\`${e.name}\`: args says default ${JSON.stringify(e.default)}, ` +
          `the zod input derives ${JSON.stringify(d.default)}`,
      );
    }
    if (
      e.oneOf.length !== d.oneOf.length ||
      e.oneOf.some((v, i) => v !== d.oneOf[i])
    ) {
      problems.push(
        `\`${e.name}\`: args says one_of ${JSON.stringify(e.oneOf)}, ` +
          `the zod input derives ${JSON.stringify(d.oneOf)}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `endpoint ${iri}: explicit args and the zod input disagree — ` +
        problems.join("; ") +
        " (explicit args win only when they match the schema that " +
        "validates at dispatch)",
    );
  }
}

/**
 * Declare a single-verb Source endpoint whose ArgSpecs derive from a zod
 * object schema, and whose every dispatch is validated by that same schema
 * before the handler runs. The handler receives the parsed, TYPED output.
 *
 * `options.args` may still be given; it is checked against the derivation
 * (loudly) and then wins as the describe face.
 */
export function endpoint<S extends z.ZodObject>(
  iri: string,
  options: ZodEndpointOptions<S>,
  handler: ZodHandler<S>,
): EndpointDef {
  const { input, ...rest } = options;
  const derivation = derive(input);
  let specs: readonly ArgSpec[] = derivation.specs;
  if (rest.args !== undefined) {
    const explicit = rest.args.map((a) => new ArgSpec(a));
    assertSpecsMatch(iri, explicit, derivation.specs);
    specs = explicit;
  }
  // The wrapper would otherwise donate its own (meaningless) name as the id.
  const id = rest.id ?? (handler.name || iri.slice(iri.lastIndexOf(":") + 1));
  const validating: Handler = async (args) => {
    const coerced: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(args)) {
      coerced[name] = coerceValue(name, value, derivation.props.get(name));
    }
    const parsed = input.safeParse(coerced);
    if (!parsed.success) throw invalidArguments(parsed.error);
    return await handler(parsed.data as z.output<S>);
  };
  return new EndpointDef(validating, iri, { ...rest, id, args: [...specs] });
}
