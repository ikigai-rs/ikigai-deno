// Supplemental references generated with published ikigai-core = "=0.2.2"
// and serde_json = "1". Run as a Cargo binary and copy stdout verbatim to
// tests/existence_contract_vectors.json. Core PR 255 added the hash rule but
// core's shared contract_vectors.json has no sensitive case as of
// 6a72a55b5763a28e8cc19181598575af88edf58f; keep that shared copy unchanged.
use ikigai_core::{ActionSpec, FailureClass, Verb};
use serde_json::json;
fn main() {
    let open = ActionSpec::new(Verb::Source).requires("urn:cap:x");
    let cases = [
        ("sensitive", open.clone().existence_sensitive()),
        ("sensitive-with-failures", open.clone().fails(FailureClass::Transient).existence_sensitive()),
        ("open", open.clone()),
        ("open-with-failures", open.fails(FailureClass::Transient)),
    ];
    let vectors: Vec<_> = cases.into_iter().map(|(name, action)| json!({
        "name": name, "id": "state", "action": action, "contract": action.contract_iri("state")
    })).collect();
    println!("{}", serde_json::to_string_pretty(&vectors).unwrap());
}
