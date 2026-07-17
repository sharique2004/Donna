import { describe, it, expect } from 'vitest';
import { D1Store } from '../src/core/memory/d1Store.js';
import type { CallRecord } from '../src/core/types.js';

/**
 * D1Store had no test at all, which is the only reason the `directed` bug
 * shipped: the flag was added to CallRecord and read by dispatchMachine, but
 * saveCall never bound it and `calls` had no column for it. Every existing test
 * runs against an in-memory fake that holds CallRecord objects whole, so the
 * field survived there and vanished only on the store that production uses.
 *
 * So the fake below deliberately does NOT hold objects. It parses the column
 * list out of the INSERT and keeps only those columns — the one property of a
 * real table that matters here. A field the SQL forgets is a field that comes
 * back undefined, exactly as D1 did. Revert either half of the fix and these
 * fail.
 *
 * This is not a SQL engine: it understands the two statements D1Store uses for
 * a save/read round-trip and nothing else. A genuine D1 test needs miniflare or
 * node:sqlite (Node >= 22.5; this repo is on 20.x), which is a bigger change
 * than this fix should carry.
 */
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();

  const stmt = (sql: string) => ({
    bind(...vals: unknown[]) {
      return {
        async run() {
          const m = sql.match(/INSERT OR REPLACE INTO calls \(([^)]+)\)/);
          if (!m) throw new Error(`fakeDb: unsupported statement: ${sql}`);
          const cols = m[1].split(',').map((c) => c.trim());
          if (cols.length !== vals.length) {
            throw new Error(`fakeDb: ${cols.length} columns but ${vals.length} bindings`);
          }
          const row: Record<string, unknown> = {};
          cols.forEach((c, i) => { row[c] = vals[i]; });
          rows.set(String(row.call_id), row);
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          return (rows.get(String(vals[0])) ?? null) as T | null;
        },
      };
    },
  });

  return { prepare: stmt } as unknown as ConstructorParameters<typeof D1Store>[0];
}

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  callId: 'c1',
  donationId: 'd1',
  itemId: 'i1',
  recipientId: 'r1',
  candidateIndex: 0,
  placedAt: '2026-07-16T00:00:00.000Z',
  ...over,
});

describe('D1Store — CallRecord round-trip', () => {
  it('persists `directed` so a declined directed call cannot advance the machine', async () => {
    const store = new D1Store(fakeDb());
    await store.saveCall(call({ directed: true }));

    const got = await store.getCall('c1');

    // dispatchMachine gates on `call.directed` being truthy. When D1 dropped the
    // column this read back undefined and a coordinator's declined call marched
    // dispatch on to the next-ranked pantry behind their back.
    expect(got?.directed).toBe(true);
  });

  it('leaves `directed` absent on an automatic call, matching JsonStore', async () => {
    const store = new D1Store(fakeDb());
    await store.saveCall(call());

    const got = await store.getCall('c1');

    expect(got?.directed).toBeUndefined();
  });

  it('round-trips the rest of the record unchanged', async () => {
    const store = new D1Store(fakeDb());
    const original = call({ candidateIndex: 2, handledAt: '2026-07-16T00:05:00.000Z' });
    await store.saveCall(original);

    expect(await store.getCall('c1')).toEqual(original);
  });
});
