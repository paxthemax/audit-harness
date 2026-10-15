# Contract version 1: serialization, hashing and store layout

The interface contracts require an implementation to publish its serialization and hashing rules for each contract version ([design/harness-interface-contracts.md](../../framework-design-lab/design/harness-interface-contracts.md#contract-conventions)). These are the rules for contract version 1.

## Requests

Every controller request carries:

| Field | Meaning |
|---|---|
| `contract_version` | `1`. Any other value is refused with `unsupported_contract` |
| `request_id` | Producer-generated identifier, recorded on the event |
| `idempotency_key` | Optional. Scoped to the engagement, the authenticated principal and the operation |
| `engagement_id` | The engagement, or `library` for decisions about the mechanism library itself |
| `operation` | A registered operation name (`harness call --list` prints them) |
| `expected_revisions` | Exact `{record_id, revision}` the caller based its request on |
| `payload` | Operation-specific typed payload |

The caller's identity comes from the channel, never from the payload. The channels are:

| Channel | Authenticated by | Used for |
|---|---|---|
| `auditor` | `secrets/auditor.key` | The auditor's own non-decision operations |
| `screen` | `secrets/auditor.key` plus an interactive terminal (the trusted decision screen) | Every human decision, display receipts |
| `capture` | `secrets/capture.key` | `capture_input` only |
| `worker` | A per-attempt grant token; only its digest is stored | Operations listed in the attempt's grant |
| `runner`, `controller` | In-process only | Trusted runner receipts, scheduling, policy stops; the yolo governor (`harness yolo run`) as the principal `yolo-governor`, limited to requesting work and recording its `yolo_run` records |

A repeated idempotency key with the same request digest returns the historical result with `replayed.state_changed_since`. The same key with different contents is refused with `idempotency_conflict`. In the walking skeleton the key is detected against committed events; there is no separate idempotency store (a [deferred mechanism](../../framework-design-lab/design/harness-state-and-execution.md#deferred-mechanisms)).

## Canonical JSON and digests

- **Canonical JSON** is UTF-8 with object keys sorted by UTF-16 code unit, no insignificant whitespace, members whose value is `undefined` dropped, `undefined` array elements written as `null`, and non-finite numbers rejected (`src/core/hash.ts`).
- **Digests** are SHA-256, written `sha256:<64 lowercase hex>`. A content digest is taken over raw bytes; a JSON digest over canonical JSON.
- **Request digest** (idempotency): digest of canonical JSON `{operation, engagement, payload, expected}`.
- **Dependency digest** (decisions): digest of the sorted list of `record_id@revision` keys in the transitive `depends_on` closure of the reviewed revisions.
- **Inbound-link digest** (packets and dispositions): digest of the sorted `record_id@revision` keys of records linked to the investigation: evidence through its jobs or `positive_control_for`, discrepancies, clarifications that block it, statements that cite it, its scenario variants, freshness records and probes. The **evidence watermark** is the count of eligible linked evidence records. Both are computed by the controller when it builds the packet and again when the decision commits.

Hashes identify bytes. They do not prove that content is true, and they do not defeat a compromised host administrator.

## References

A reference is `{record_id, revision}` and may carry `scope` when it leaves its engagement. A cross-scope reference grants no access. An artifact reference is `{artifact: "sha256:..."}`. An identifier without a revision can find the current record but cannot bind an approval or an execution input. Unknown values are explicit: `{unknown: true, reason}`.

## Store layout

Each engagement, and the mechanism library, is an append-only Git repository:

```text
<workspace>/engagements/<engagement-id>/
  store.json                       scope, format and store identity
  records/<record_id>/<rev>.json   one immutable file per record revision (envelope + body)
  events/<seq>.json                one event per committed operation, monotonic sequence
  archive/sha256/<2 hex>/<hex>     content-addressed evidence blobs
  quarantine/                      uncommitted material found on open (not tracked)
```

One controller operation is one Git commit containing the new revision files, its events and the archive blobs it references. That commit is the atomic record/event transaction. Files written without a commit were never acknowledged: on open they move to `quarantine/` and the acknowledged state is restored from Git. A committed record that fails its schema makes the store refuse writes (`store_corrupt`). Git runs with hooks, signing and user configuration disabled.

Record envelopes and event envelopes are validated against the JSON Schemas in `src/schema/records.ts`; `harness schemas --out <dir>` writes them as files.

## Record identity

Record identifiers are engagement-scoped `<prefix>-<seq>` (for example `inv-0003`). Mechanism-library records use library-scoped identifiers in the `library` scope. A record never changes type; every change is a new revision, and earlier revisions stay readable.

`depends_on` lists only the material inputs a record's meaning relies on. Parent links, such as a variant's investigation, live in the body. A decision is refused with `stale_dependency` when any reviewed revision, or one of its direct `depends_on` inputs, has a newer revision; the deeper closure feeds the dependency digest and the list of unreviewed statements. Each decision needs its own display receipt: a receipt that already backs a decision is refused with `display_required`.
