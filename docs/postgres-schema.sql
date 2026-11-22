-- Server side of offline-first-sync-engine on PostgreSQL 16+.
-- The in-memory SyncServer in src/server.ts follows exactly these rules.

create table sync_log (
  seq        bigint generated always as identity primary key,  -- the pull cursor
  ts         text   not null unique,                            -- HLC timestamp = operation identity
  client_id  text   not null,
  collection text   not null,
  doc_id     text   not null,
  kind       text   not null check (kind in ('set', 'delete')),
  field      text,
  value      jsonb,
  received_at timestamptz not null default now(),
  check ((kind = 'set' and field is not null) or (kind = 'delete' and field is null and value is null)),
  check (split_part(ts, ':', 3) = client_id)                    -- a client stamps only its own ops
);

-- Merged state, one row per field plus one row per tombstone.
create table sync_field (
  collection text not null,
  doc_id     text not null,
  field      text not null,
  value      jsonb,
  ts         text not null,
  primary key (collection, doc_id, field)
);

create table sync_tombstone (
  collection text not null,
  doc_id     text not null,
  deleted_at text not null,
  primary key (collection, doc_id)
);

-- Push, per operation, inside ONE transaction for the batch:
--
--   insert into sync_log (ts, client_id, collection, doc_id, kind, field, value)
--   values ($1, $2, $3, $4, $5, $6, $7)
--   on conflict (ts) do nothing
--   returning seq;
--
--   -- no row returned: a retry. Compare the stored row; same content = accepted, else reject.
--
--   insert into sync_field as f (collection, doc_id, field, value, ts)
--   values ($3, $4, $6, $7, $1)
--   on conflict (collection, doc_id, field) do update
--     set value = excluded.value, ts = excluded.ts
--     where excluded.ts > f.ts;                 -- last writer wins, by HLC
--
--   insert into sync_tombstone as t (collection, doc_id, deleted_at)
--   values ($3, $4, $1)
--   on conflict (collection, doc_id) do update
--     set deleted_at = excluded.deleted_at
--     where excluded.deleted_at > t.deleted_at;
--
-- Pull:
--
--   select * from sync_log where seq > $cursor order by seq limit $limit;
--
-- Caveat on sequences: identity values are assigned at insert time but become visible at commit,
-- so a reader can see seq 11 before a slower transaction commits seq 10 and then skip 10 forever.
-- Either serialize pushes (pg_advisory_xact_lock on a constant) or only serve rows with
-- seq <= the lowest seq still in flight. The reference server is single-threaded, so it has no
-- such gap.
