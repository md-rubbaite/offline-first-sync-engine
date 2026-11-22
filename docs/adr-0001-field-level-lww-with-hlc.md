# ADR-0001: Field-level last-writer-wins with hybrid logical clocks

- Status: accepted
- Date: 2026-11-22

## Context

Field workers, clinics and sales teams use apps on phones and laptops with poor connectivity. They
must be able to create and edit records offline, and the edits must merge without data loss when
devices reconnect, possibly after days, through networks that drop, duplicate and retry requests.

Options considered:

| Option | Merge result | Cost |
|---|---|---|
| Whole-record last-writer-wins on wall clock | One device's edit to a record silently erases another device's edit to a *different* field. Wrong device clocks pick the wrong winner. | Lowest |
| Server-side locking or "online only for edits" | No offline editing | Breaks the requirement |
| Operational transformation | Precise for text | Needs a central sequencer for every edit; complex |
| Sequence CRDTs (Yjs, Automerge) | Precise, including collaborative text | Larger library, opaque binary state, harder to query in SQL |
| **Per-field LWW registers ordered by HLC + document tombstones** | Concurrent edits to different fields both survive; same-field conflicts resolve deterministically | Small, auditable, maps to plain SQL tables |

## Decision

1. Every field is a last-writer-wins register. A change is a single-field operation stamped with a
   hybrid logical clock timestamp `(wall ms, counter, node id)`.
2. The HLC never goes backwards on a device (persisted across restarts), moves past every timestamp
   it has seen, and the server rejects timestamps more than 5 minutes in the future. A device
   whose clock is wrong by minutes therefore cannot win every conflict for days.
3. The timestamp is also the operation's identity. The server stores each identity once; a retry
   with identical content is acknowledged again, a different operation reusing an identity is
   rejected. A client may only stamp operations with its own node id.
4. A delete is a tombstone timestamp on the document. Fields older than the tombstone are hidden;
   a field written later (by HLC order) is visible, so an edit made offline after a delete is not
   lost.
5. The client keeps the server-confirmed state and a durable outbox separately and shows confirmed +
   outbox. A rejected operation disappears on the next sync without manual rollback.
6. The server log is numbered; clients pull by cursor. Old log entries can be compacted into a
   snapshot; a client behind the horizon receives the snapshot and continues from there.

## Consequences

- Good: merge is commutative, associative and idempotent, tested with randomized network faults
  (lost requests, lost responses, duplicates, offline periods, restarts, compaction).
- Good: the state is three ordinary tables (docs/postgres-schema.sql), easy to query, back up and audit.
- Limitation: two people editing the *same field* concurrently keep only the later edit. For
  collaborative rich text, use a sequence CRDT for that field.
- Limitation: no cross-field invariants (for example "stock never below zero"). Model those as
  server-validated commands, not free-form field writes.
- Limitation: a deleted document can be revived by a later edit from a device that did not see the
  delete. This is deliberate (no silent data loss); surface it in the UI if it matters.
