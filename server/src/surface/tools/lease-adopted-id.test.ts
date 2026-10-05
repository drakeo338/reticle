/**
 * A lease must recognise the tab it opened, even when the app named the session itself.
 *
 * `appendReticleParams` stamps `__reticle_session=<leaseId>` on the URL so the app's SDK adopts the
 * lease's identity with no app changes. An app that passes an explicit `session` to `connect()` keeps
 * its own name instead — which is legitimate, and what a single-app fixture does deliberately so a
 * battery can address it by a known id.
 *
 * Readiness was an exact lookup of the lease id, so for those apps it could never be satisfied. The
 * lease returned `ready: false` with a hint saying the tab "never dialled this daemon", and the usual
 * cause is "a PORT MISMATCH" — while a session for that exact URL was connected and driveable at that
 * moment, on that daemon. Seen on next-smoke: `reticle_sessions` listed it one second later with the
 * lease id sitting in its own URL.
 *
 * That is the expensive kind of wrong. The hint sends the reader to check ports, `.reticle.json` and
 * `RETICLE_PORT`, none of which is the problem, and the returned `sessionId` addresses a session that
 * does not exist — so every later call fails too.
 *
 * The URL is the evidence, and the daemon already has it. Resolve the lease to whatever session
 * carries its marker, and return THAT id, because it is the one the agent has to drive with.
 */

import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import { acquireLeasedSession, LEASE_ACQUIRE_TOOL, resolveLeasedSessionId } from './lease-tools.js';
import type { BrowserPool } from '@/portal/pool/browser-pool.js';
import type { ToolDeps } from './tool-kit.js';
import { connectedUnderOtherIdNote } from './lease-session-match.js';

const LEASE_ID = 'lease-abc';
const leaseUrl = (base: string): string =>
  `${base}?${RETICLE_URL_PARAM.SESSION}=${encodeURIComponent(LEASE_ID)}`;

interface FakeSession {
  id: string;
  url?: string;
}

const sessions = (rows: FakeSession[]) => ({
  get: (id: string): FakeSession | undefined => rows.find((s) => s.id === id),
  all: (): FakeSession[] => rows,
});

describe('a lease resolves to the session its tab actually registered', () => {
  it('uses the lease id when the SDK adopted it', () => {
    const live = sessions([{ id: LEASE_ID, url: leaseUrl('http://localhost:3000/') }]);
    expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(LEASE_ID);
  });

  it('finds a session that kept its OWN name but carries the lease marker', () => {
    // The reported case. The app pinned `session: 'next-smoke'`, so nothing is registered under the
    // lease id — but the tab this lease opened is right there, with the marker in its URL.
    const live = sessions([{ id: 'next-smoke', url: leaseUrl('http://localhost:3100/') }]);
    expect(
      resolveLeasedSessionId(live, LEASE_ID),
      'the returned id is the one the agent has to drive with, so it must be the registered one',
    ).toBe('next-smoke');
  });

  it('does not adopt a session from a DIFFERENT lease', () => {
    // The marker is what makes this safe. Two leases open two tabs, and matching on origin alone
    // would hand the second lease the first one's session.
    const live = sessions([
      { id: 'other', url: `http://localhost:3100/?${RETICLE_URL_PARAM.SESSION}=lease-zzz` },
    ]);
    expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(undefined);
  });

  it('is undefined while nothing has connected, so the hint still fires when it should', () => {
    expect(resolveLeasedSessionId(sessions([]), LEASE_ID)).toBe(undefined);
  });

  it('ignores a session with no url rather than throwing', () => {
    expect(resolveLeasedSessionId(sessions([{ id: 'urlless' }]), LEASE_ID)).toBe(undefined);
  });

  it('does not match a lease id that is merely a PREFIX of another', () => {
    // `lease-abc` must not adopt `lease-abcdef`'s tab. A substring test on the raw URL would.
    const live = sessions([
      { id: 'app', url: `http://localhost:3100/?${RETICLE_URL_PARAM.SESSION}=lease-abcdef` },
    ]);
    expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(undefined);
  });

  describe('a server redirect dropped the marker from the URL', () => {
    // `/private` 302s to `/login` and the query string goes with it. Nothing then proves whose tab
    // is on `/login`, and a person can open the same URL in the same window, so it is never adopted.
    const PAGE = 'http://localhost:3100/login';

    it('does not adopt an unmarked session on the lease page URL', () => {
      const live = sessions([{ id: 'redirected', url: PAGE }]);
      expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(undefined);
    });

    it('does not adopt a person tab that connected after the lease snapshot', () => {
      // The Greptile case: the only new unmarked session at the URL is the person's.
      const live = sessions([{ id: 'humans-tab', url: PAGE }]);
      expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(undefined);
    });
  });

  describe('when a lease still matches nothing', () => {
    const PAGE = 'http://localhost:3100/login';

    it('names the id the tab connected under and the url', () => {
      const note = connectedUnderOtherIdNote([{ id: 'redirected', url: PAGE }], LEASE_ID, PAGE);
      expect(note).toContain('redirected');
      expect(note).toContain(PAGE);
      expect(note).toContain(LEASE_ID);
      expect(note, 'must not tell the agent to drive an unverified tab').toContain(
        'may be a person',
      );
    });

    it('names no session when several sit on the page, since it cannot say which is the lease', () => {
      const note = connectedUnderOtherIdNote(
        [
          { id: 'a', url: PAGE },
          { id: 'b', url: PAGE },
        ],
        LEASE_ID,
        PAGE,
      );
      expect(note).toBe('');
    });

    it('does not name a tab that was connected before the lease', () => {
      const all = [{ id: 'humans-tab', url: PAGE }];
      expect(connectedUnderOtherIdNote(all, LEASE_ID, PAGE, new Set(['humans-tab']))).toBe('');
    });

    it('says nothing when no session sits on the page', () => {
      expect(connectedUnderOtherIdNote([], LEASE_ID, PAGE)).toBe('');
      expect(connectedUnderOtherIdNote([{ id: 'x', url: PAGE }], LEASE_ID, undefined)).toBe('');
    });
  });
});

describe('acquire through a redirect', () => {
  const REQUESTED = 'http://localhost:3100/private';
  const LANDED = 'http://localhost:3100/login';

  /** A pool double whose page ends up on `landed` after the navigation, as a server redirect does. */
  function redirectingPool(
    landed: string | undefined,
    onAcquire: () => void = () => undefined,
  ): {
    pool: BrowserPool;
    aliased: [string, string][];
  } {
    const aliased: [string, string][] = [];
    const pool = {
      acquire: (url: string, opts: { sessionId?: string } = {}) => {
        onAcquire();
        return Promise.resolve({
          sessionId: opts.sessionId ?? 'gen',
          url,
          release: () => Promise.resolve(),
        });
      },
      release: () => Promise.resolve(),
      activeCount: () => 1,
      queuedCount: () => 0,
      leasedSessionIds: () => [],
      leaseTtlMs: () => 300_000,
      leaseIdOnOrigin: () => undefined,
      touch: () => undefined,
      alias: (registeredId: string, leaseId: string) => aliased.push([registeredId, leaseId]),
      pageUrl: () => landed,
    } as unknown as BrowserPool;
    return { pool, aliased };
  }

  it('acquireLeasedSession does not bind an unmarked redirected tab to the lease', async () => {
    const rows: FakeSession[] = [];
    const { pool, aliased } = redirectingPool(LANDED, () =>
      rows.push({ id: 'redirected', url: LANDED }),
    );
    const got = await acquireLeasedSession(pool, sessions(rows), REQUESTED);
    expect(got.sessionId).toMatch(/^lease-/);
    expect(aliased).toEqual([]);
  }, 20_000);

  it('acquireLeasedSession ignores a human tab that was already on the landing URL', async () => {
    // Only the pre-existing tab is there, so the lease's own SDK never connected: the lease must not
    // report the human's tab as its own.
    const { pool, aliased } = redirectingPool(LANDED);
    const live = sessions([{ id: 'humans-tab', url: LANDED }]);
    const got = await acquireLeasedSession(pool, live, REQUESTED);
    expect(got.sessionId).toMatch(/^lease-/);
    expect(aliased).toEqual([]);
  }, 20_000);

  it('acquireLeasedSession keeps the lease id when the pool reports no page URL', async () => {
    const rows: FakeSession[] = [];
    const { pool } = redirectingPool(undefined, () => rows.push({ id: 'redirected', url: LANDED }));
    const got = await acquireLeasedSession(pool, sessions(rows), REQUESTED);
    expect(got.sessionId).toMatch(/^lease-/);
  }, 20_000);

  it('reticle_lease acquire stays not-ready after a redirect and names the candidate', async () => {
    const rows: FakeSession[] = [];
    const { pool } = redirectingPool(LANDED, () => rows.push({ id: 'redirected', url: LANDED }));
    const deps = {
      pool,
      sessions: { ...sessions(rows), lastClosure: () => undefined },
    } as unknown as ToolDeps;
    const out = (await LEASE_ACQUIRE_TOOL.handler(deps, { url: REQUESTED })) as Record<
      string,
      unknown
    >;
    expect(out['sessionId']).toMatch(/^lease-/);
    expect(out['ready']).toBe(false);
    expect(String(out['hint'])).toContain('redirected');
  }, 20_000);
});
