/**
 * A vector's serde description as this package's model, and a door that serves
 * it: the adapter the shared-vector tests (`contract_test.ts`,
 * `capability_test.ts`) read core's JSON through, so the description a vector
 * carries goes through the same renderers and the same floor this package's own
 * doors use.
 */

import { assert } from "@std/assert";
import {
  type ActionSpecModel,
  ArgSpec,
  type ArgSpecInput,
  type DescriptionModel,
  ServedDef,
} from "../src/serve.ts";
import { type Reply, Verb } from "../src/wire.ts";

/** A JSON object, as a vector file holds it. */
export type Json = Record<string, unknown>;

export const verbOf = (name: string): Verb => {
  const verb = Verb[name as keyof typeof Verb];
  assert(verb !== undefined, `not a verb: ${name}`);
  return verb;
};

export const list = <T>(from: Json, key: string): T[] =>
  (from[key] as T[] | undefined) ?? [];

/** A serde `ArgSpec` (the JSON Meta face's shape) as this package's ArgSpec. */
export function argSpec(json: Json): ArgSpec {
  const input: ArgSpecInput = {
    name: json["name"] as string,
    summary: json["summary"] as string,
    required: json["required"] as boolean,
    source: json["source"] as "argument" | "binding",
  };
  if ("class" in json) input.class = json["class"] as string;
  if ("default" in json) input.default = json["default"] as string;
  if ("one_of" in json) input.oneOf = json["one_of"] as string[];
  return new ArgSpec(input);
}

/** A serde `ikigai_core::ActionSpec` as this package's model. */
export function actionSpec(json: Json): ActionSpecModel {
  return {
    verb: verbOf(json["verb"] as string),
    summary: (json["summary"] as string | undefined) ?? "",
    inputs: list<Json>(json, "inputs").map(argSpec),
    outputs: list<string>(json, "outputs"),
    requires: list<string>(json, "requires"),
  };
}

/** A serde `ikigai_core::Description` as this package's model. */
export function descriptionModel(json: Json): DescriptionModel {
  return {
    id: json["id"] as string,
    title: json["title"] as string,
    summary: json["summary"] as string,
    verbs: list<string>(json, "verbs").map(verbOf),
    inputs: list<Json>(json, "inputs").map(argSpec),
    outputs: list<string>(json, "outputs"),
    requires: list<string>(json, "requires"),
    actions: list<Json>(json, "actions").map(actionSpec),
  };
}

/**
 * A door that answers Meta with a given description and nothing else, so a
 * vector's description (another face's door included) goes through the same
 * renderers this package's own doors use.
 *
 * The renderers read only the DESCRIPTION, so the door's own pattern is not
 * what is under test here. It cannot be the vector's `pattern` either: this
 * face's served doors are `urn:`-only (`ServedDef`'s declaration guard, as in
 * ikigai-python), and core's own `core/bracket-names` door is registered at
 * `http://[::1]:8080/{key}`. A vector's pattern is checked where it IS the
 * subject, straight from the file (the `matches` section).
 */
export class VectorDoor extends ServedDef {
  readonly #model: DescriptionModel;

  constructor(json: Json, pattern = "urn:vector") {
    super(pattern, {}, json["id"] as string);
    this.#model = descriptionModel(json);
  }

  description(): DescriptionModel {
    return this.#model;
  }

  answer(): Promise<Reply> {
    throw new Error("a vector door answers Meta only");
  }

  protected answeredVerbs(): Verb[] {
    return [];
  }
}
