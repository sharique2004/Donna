-- Donna — Cloudflare D1 (SQLite) schema for src/core/memory/d1Store.ts
--
-- Apply with:
--   wrangler d1 execute <DB> --file=d1/schema.sql            (local)
--   wrangler d1 execute <DB> --remote --file=d1/schema.sql   (deployed)
--
-- Shape note: this is a document store with indexable columns bolted on, not a
-- reporting database. Donations/recipients/config keep their canonical form as
-- JSON in a `json` column; the scalar columns exist only for the queries the
-- app actually runs (list, filter, sweep, and the equity ledger). That keeps
-- migration churn near zero as the domain types evolve — a new optional field on
-- Donation is a code change, not a schema change.

-- ---------------------------------------------------------------------------
-- donations — whole Donation document (items, attempts, cursor) as JSON.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS donations (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  received_at TEXT NOT NULL,
  json        TEXT NOT NULL
);

-- Listing is newest-first by received_at; status filtering rides the same scan.
CREATE INDEX IF NOT EXISTS idx_donations_received_at ON donations (received_at);
CREATE INDEX IF NOT EXISTS idx_donations_status      ON donations (status);

-- ---------------------------------------------------------------------------
-- recipients — Recipient document as JSON.
--
-- received_recent_lbs is promoted to a real column because creditReceived()
-- updates it on every accepted drop and it feeds the equity term of the score.
-- A read-modify-write through JSON would race; as a column it is a single
-- atomic `SET x = x + ?`. d1Store keeps the column and the JSON in sync on
-- every write (json_set on credit, re-serialize on update) — the column is the
-- authority, the JSON copy is for whole-object reads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipients (
  id                  TEXT PRIMARY KEY,
  json                TEXT NOT NULL,
  received_recent_lbs REAL NOT NULL
);

-- ---------------------------------------------------------------------------
-- history — HistoryEvent, fully columnar: it is small, flat, and always
-- filtered by recipient_id (the simulator's 7-day category memory reads it).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS history (
  id           TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  item_id      TEXT,
  outcome      TEXT NOT NULL,
  reason       TEXT,
  at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_recipient_id ON history (recipient_id);

-- ---------------------------------------------------------------------------
-- config — exactly one row. The CHECK is the singleton guard, so an
-- INSERT OR REPLACE with id=1 is a total upsert and no code path can fork the
-- config into two rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- calls — the persisted replacement for vapi.ts's in-memory `pending` map.
--
-- call_id is the PRIMARY KEY and that IS the idempotency guard: claimCall does
-- `UPDATE calls SET handled_at=? WHERE call_id=? AND handled_at IS NULL` and
-- reads meta.changes. VAPI provably sends more than one end-of-call-report per
-- call; a read-then-write would let two concurrent invocations both see NULL and
-- both advance the machine, double-dialling the next pantry. The conditional
-- UPDATE collapses that to one winner inside a single statement.
-- ---------------------------------------------------------------------------
-- `directed` is a real column, not a JSON field, because this table is the one
-- exception to the shape note above: calls have no `json` column to hide an
-- optional field in, so anything CallRecord carries must be spelled out here or
-- it is silently dropped on write. It was: the flag was added to the type and to
-- dispatchMachine, and on D1 every directed call read back as undefined, so a
-- declined coordinator-directed call advanced to the next ranked pantry — the
-- exact behaviour the flag exists to prevent.
--
-- SQLite has no boolean: 0/1, defaulting 0 (an unflagged call is automatic).
CREATE TABLE IF NOT EXISTS calls (
  call_id         TEXT PRIMARY KEY,
  donation_id     TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  recipient_id    TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  placed_at       TEXT NOT NULL,
  handled_at      TEXT,
  directed        INTEGER NOT NULL DEFAULT 0
);

-- MIGRATION — existing databases only.
--
-- Everything above is CREATE TABLE IF NOT EXISTS, so re-running this file
-- against a database that already has `calls` is a no-op and will NOT add the
-- column. Any deployment created before this commit needs the ALTER once:
--
--   wrangler d1 execute donna --remote --command \
--     "ALTER TABLE calls ADD COLUMN directed INTEGER NOT NULL DEFAULT 0"
--
-- It is safe on rows already there (they are automatic calls, which is 0) and
-- errors with "duplicate column name" if applied twice — loud, not harmful.

-- The cron stale sweep asks: unhandled AND placed before X. Leading with
-- handled_at means the (tiny) unhandled set is the only part scanned, even once
-- the handled rows dominate the table.
CREATE INDEX IF NOT EXISTS idx_calls_unhandled ON calls (handled_at, placed_at);

-- ---------------------------------------------------------------------------
-- live_lines — ephemeral in-flight transcript for the stage dashboard.
--
-- (call_id, seq) is the PK, so the rows are physically ordered by the reading
-- order and "the last line for this call" is MAX(seq) — the lookup
-- appendLiveLine needs for the rolling-partial replace rule.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_lines (
  call_id TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  speaker TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  PRIMARY KEY (call_id, seq)
);
