//! The generator of `contract_vectors.json`: what a RELEASED ikigai-core renders for
//! the doors in `contract_cases.ts`. Not built by anything in this repo (it is Rust in
//! a Deno package); it is committed so the vectors' provenance is a program, not a
//! claim. To regenerate, in a scratch cargo project (never this repo):
//!
//! ```text
//! cargo new --bin contract-ref && cd contract-ref
//! # [dependencies]: ikigai-core = "=0.1.92", ikigai-vocab = "=0.1.92", serde_json = "1"
//! cp <ikigai-deno>/tests/contract_vectors.rs src/main.rs
//! deno run --config <ikigai-deno>/deno.json <ikigai-deno>/tests/contract_cases.ts \
//!   | cargo run --quiet > <ikigai-deno>/tests/contract_vectors.json
//! deno fmt <ikigai-deno>/tests/contract_vectors.json
//! ```
//!
//! It reads `[{case, description}]` (each door's JSON Meta face, the form a Rust host
//! deserializes when it mounts this peer), deserializes each as `ikigai_core::Description`
//! and records `ikigai_vocab::to_turtle` and every action's `ActionSpec::contract_iri`,
//! plus a few `match_iri` vectors.

use ikigai_core::{match_iri, Description, Verb};
use serde_json::{json, Value};
use std::io::Read;

const CORE: &str = "0.1.92";

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
    let mut out = Vec::new();
    for case in cases {
        let d: Description = serde_json::from_value(case["description"].clone()).unwrap();
        let contracts: Vec<Value> = d
            .action_specs()
            .iter()
            .map(|a| json!({"verb": format!("{:?}", a.verb), "iri": a.contract_iri(&d.id)}))
            .collect();
        out.push(json!({
            "case": case["case"],
            "description": case["description"],
            "contracts": contracts,
            "turtle": ikigai_vocab::to_turtle(&d),
        }));
    }
    let matches: Vec<Value> = [
        (Verb::Source, "urn:iki:fn:toUpper"),
        (Verb::Source, "urn:file:{path}"),
        (Verb::Sink, "urn:ts:kv:{bucket}:{key}"),
        (Verb::Delete, "urn:a:%7B"),
        (Verb::Exists, "urn:ts:naïve 𝄞|x"),
    ]
    .iter()
    .map(|(v, p)| json!({"verb": format!("{v:?}"), "pattern": p, "iri": match_iri(*v, p)}))
    .collect();
    let doc = json!({
        "producedBy": format!(
            "tests/contract_vectors.rs built against ikigai-core and ikigai-vocab ={CORE} \
             from crates.io, fed tests/contract_cases.ts"
        ),
        "core": CORE,
        "cases": out,
        "matches": matches,
    });
    println!("{}", serde_json::to_string_pretty(&doc).unwrap());
}
