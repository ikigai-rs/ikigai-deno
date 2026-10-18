/**
 * The pre-flight check: an action's contract applied to a proposed set of
 * named arguments. A port of ikigai-core's one checker, `ActionSpec::check`
 * (`check.rs`, ledger #1547), held to it by `tests/validation_vectors.json`, a
 * VERBATIM copy of core's `validation_vectors.json`: required, `one_of` per
 * item, class plausibility, given-twice and list joining, groups, `needs`
 * (an input's and a value's), the empty enumeration, and open and envelope
 * argument sets.
 *
 * ```ts
 * import { ArgSpec, checkAction } from "@ikigai/wire/serve";
 * import { Verb } from "@ikigai/wire";
 *
 * const spec = {
 *   verb: Verb.Sink,
 *   summary: "",
 *   inputs: [new ArgSpec("start"), new ArgSpec({ name: "mode", oneOf: ["add"] })],
 *   outputs: [],
 *   requires: [],
 * };
 * checkAction(spec, [["start", "today"], ["mode", "add"]]); // []
 * checkAction(spec, [["mode", "gone"], ["when", "now"]]).map((v) => v.kind);
 * // ["missing", "not-one-of", "unknown"]
 * ```
 *
 * @module
 */

import { groupSegment } from "./contract.ts";
import type {
  ActionSpecModel,
  ArgSpec,
  InputGroup,
  ListSeparator,
} from "./serve.ts";

/** What rule a {@linkcode Violation} breaks (core's `ViolationKind::word`). */
export type ViolationKind =
  | "missing"
  | "not-one-of"
  | "implausible"
  | "unknown"
  | "exactly-one"
  | "at-least-one"
  | "at-most-one"
  | "needs"
  | "given-twice"
  | "envelope";

/** One rule a proposed call breaks. */
export interface Violation {
  /** The rule broken. */
  readonly kind: ViolationKind;
  /**
   * The contract node it is about, as the shared vectors spell it:
   * `input:{name}`, `group:{kind}:{members}` or `input:{name}:value:{value}`;
   * `null` for a name the contract does not declare.
   */
  readonly path: string | null;
  /** A human message, quoting the offending name or value. */
  readonly message: string;
}

/** The proposed `[name, value]` pairs, in the order given, repeats kept. */
export type ProposedArgs = readonly (readonly [string, string])[];

/** The detail of every refusal of a name given more than once that is not a list argument. */
export const GIVEN_TWICE =
  "given twice; an argument takes one value, so name it once";

const WHITESPACE = "\\p{White_Space}";
const TRIM = new RegExp(`^${WHITESPACE}+|${WHITESPACE}+$`, "gu");
const SPACES = new RegExp(`${WHITESPACE}+`, "u");
const COMMA_OR_SPACE = new RegExp(`[,${WHITESPACE}]`, "u");

/** Rust's `str::trim`: Unicode `White_Space`, which JavaScript's `trim` is not. */
const trim = (s: string): string => s.replace(TRIM, "");

/** Core's `given`: proposed with a value that is not blank. */
const given = (value: string | undefined): boolean =>
  value !== undefined && trim(value) !== "";

/** Core's `ListSeparator::split`: the items of a value, empties dropped. */
function splitList(separator: ListSeparator, value: string): string[] {
  const items = {
    "comma": () => value.split(",").map(trim),
    "whitespace": () => value.split(SPACES),
    "comma-or-whitespace": () => value.split(COMMA_OR_SPACE),
    "newline": () => value.split("\n").map(trim),
  }[separator]();
  return items.filter((item) => item !== "");
}

/** Core's `ListSeparator::join`: items joined with the canonical character. */
function joinList(separator: ListSeparator, items: readonly string[]): string {
  const joiner = separator === "whitespace"
    ? " "
    : separator === "newline"
    ? "\n"
    : ",";
  return items.join(joiner);
}

const XSD = "http://www.w3.org/2001/XMLSchema#";
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Core's `plausible`: whether `value` looks like a value of the XSD datatype `cls`. */
function plausible(cls: string, value: string): boolean {
  switch (cls) {
    case `${XSD}boolean`:
      return value === "true" || value === "false";
    case `${XSD}integer`: {
      if (!/^[+-]?[0-9]+$/.test(value)) return false;
      const n = BigInt(value);
      return n >= I64_MIN && n <= I64_MAX;
    }
    case `${XSD}dateTime`:
      // Core looks at the first ten BYTES; a non-ASCII byte is no digit.
      return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(value);
    default:
      return true;
  }
}

const quoted = (names: readonly string[]): string =>
  names.map((n) => `\`${n}\``).join(", ");

function checkGroup(
  group: InputGroup,
  effective: Map<string, string>,
): Violation | null {
  const present = group.members.filter((m) => given(effective.get(m)));
  const [rule, broken] = group.kind === "exactly-one"
    ? ["exactly one of", present.length !== 1] as const
    : group.kind === "at-least-one"
    ? ["at least one of", present.length === 0] as const
    : ["at most one of", present.length > 1] as const;
  if (!broken) return null;
  const got = present.length === 0 ? "got none" : `got ${quoted(present)}`;
  return {
    kind: group.kind,
    path: groupSegment(group),
    message: `${rule} ${quoted(group.members)} is required; ${got}`,
  };
}

function checkValue(input: ArgSpec, value: string): Violation | null {
  if (input.enumerated && !input.oneOf.includes(value)) {
    const accepted = input.oneOf.length === 0
      ? "it accepts none: its enumeration is empty"
      : `one of: ${input.oneOf.join(", ")}`;
    return {
      kind: "not-one-of",
      path: `input:${input.name}`,
      message:
        `\`${value}\` is not an accepted value of \`${input.name}\` (${accepted})`,
    };
  }
  if (input.cls !== null && !plausible(input.cls, value)) {
    return {
      kind: "implausible",
      path: `input:${input.name}`,
      message:
        `\`${value}\` does not look like a ${input.cls} for \`${input.name}\``,
    };
  }
  return null;
}

/**
 * One value per name, in first-seen order (core's `joined`): a list
 * argument's repeats joined with its separator's canonical character, any
 * other name's FIRST value kept, and the names repeated without being a list.
 */
function joined(
  action: ActionSpecModel,
  proposed: ProposedArgs,
): { effective: Map<string, string>; repeated: string[] } {
  const effective = new Map<string, string>();
  const repeated: string[] = [];
  const order = [...new Set(proposed.map(([name]) => name))];
  for (const name of order) {
    const values = proposed.filter(([k]) => k === name).map(([, v]) => v);
    const list = action.inputs.find((i) => i.name === name)?.list ?? null;
    if (values.length === 1) {
      effective.set(name, values[0]);
    } else if (list !== null) {
      effective.set(name, joinList(list, values));
    } else {
      repeated.push(name);
      effective.set(name, values[0]);
    }
  }
  return { effective, repeated };
}

/**
 * Check a proposed call against a contract: every rule it breaks, in a
 * stable order (each input in declaration order, then its groups, then the
 * names the contract does not declare). Empty exactly when the arguments
 * conform. Core's `ActionSpec::check`, rule for rule: a name that is not a
 * list is given once; a required by-value input is given (a binding never is
 * missing); a value, each item of a list, is one of the input's `oneOf` and
 * plausible for its XSD class; a given input's `needs`, and those of each
 * given value, are given; every group holds (a member is given when its value
 * is not blank); every name is declared unless the action's arguments are
 * open; on an envelope action the fields' rules apply when the call proposes
 * fields, the carrier's otherwise, and both at once is `envelope`.
 */
export function checkAction(
  action: ActionSpecModel,
  proposed: ProposedArgs,
): Violation[] {
  const violations: Violation[] = [];
  const { effective, repeated } = joined(action, proposed);
  const args = action.arguments;
  const carrier = args !== undefined && "envelope" in args
    ? args.envelope
    : null;
  const fieldsGiven = carrier !== null &&
    action.inputs.some((i) =>
      i.name !== carrier && given(effective.get(i.name))
    );
  if (carrier !== null && fieldsGiven && given(effective.get(carrier))) {
    violations.push({
      kind: "envelope",
      path: `input:${carrier}`,
      message:
        `the body is given twice: as \`${carrier}\` and as the fields that ` +
        "belong inside it; give one",
    });
  }
  for (const input of action.inputs) {
    // Which of an envelope's inputs this call is about: the fields, or the carrier.
    const skipped = carrier === null
      ? false
      : fieldsGiven
      ? input.name === carrier
      : input.name !== carrier && input.source === "argument";
    if (skipped) continue;
    const path = `input:${input.name}`;
    if (repeated.includes(input.name)) {
      violations.push({
        kind: "given-twice",
        path,
        message: `\`${input.name}\` is ${GIVEN_TWICE}`,
      });
    }
    const value = effective.get(input.name);
    if (input.required && input.source !== "binding" && value === undefined) {
      violations.push({
        kind: "missing",
        path,
        message: `required input \`${input.name}\` is missing`,
      });
      continue;
    }
    if (value === undefined) continue;
    const items = input.list !== null ? splitList(input.list, value) : [value];
    for (const item of items) {
      const violation = checkValue(input, item);
      if (violation !== null) violations.push(violation);
    }
    // A value's own dependencies (a value note's `needs`), per distinct item.
    for (const item of new Set(items)) {
      const note = input.values.get(item);
      if (note === undefined) continue;
      const missing = note.needs.filter((n) => !given(effective.get(n)));
      if (missing.length > 0) {
        violations.push({
          kind: "needs",
          path: `input:${input.name}:value:${item}`,
          message: `\`${input.name}=${item}\` needs ${quoted(missing)}`,
        });
      }
    }
    const missing = input.needs.filter((n) => !given(effective.get(n)));
    if (given(value) && missing.length > 0) {
      violations.push({
        kind: "needs",
        path,
        message: `\`${input.name}\` needs ${quoted(missing)}`,
      });
    }
  }
  for (const group of action.groups ?? []) {
    const violation = checkGroup(group, effective);
    if (violation !== null) violations.push(violation);
  }
  const open = args !== undefined && "open" in args;
  const unknown = new Set<string>();
  for (const [name] of proposed) {
    if (
      !open && !action.inputs.some((i) => i.name === name) &&
      !unknown.has(name)
    ) {
      unknown.add(name);
      violations.push({
        kind: "unknown",
        path: null,
        message: `unknown argument \`${name}\` — not in this action's contract`,
      });
    }
  }
  return violations;
}
