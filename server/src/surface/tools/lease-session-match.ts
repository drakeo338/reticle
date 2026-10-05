/**
 * Matching a lease to the session its tab registered. Split out of `lease-tools.ts`, which is at the
 * file-size cap; the lease tools import and re-export it.
 */

import { RETICLE_URL_PARAM } from '@reticlehq/core';

/** The `__reticle_session` marker on a URL, or undefined when it has none or is not a URL. */
export function sessionParamOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).searchParams.get(RETICLE_URL_PARAM.SESSION) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session a lease's tab actually registered as, or undefined while nothing has.
 *
 * Normally that is the lease id: `appendReticleParams` stamps `__reticle_session` on the URL and the
 * SDK adopts it. An app that passes an explicit `session` to `connect()` keeps its own name instead,
 * which is legitimate — a single-app fixture does it deliberately so a battery can address it by a
 * known id. Matching on the lease id alone could never see those tabs, so the lease reported
 * `ready: false` and a hint blaming a port mismatch while the session was connected and driveable.
 *
 * The URL marker is the evidence, and it is what makes this safe: two concurrent leases on one origin
 * carry different markers, so neither can adopt the other's tab. Parsed rather than substring-matched,
 * so `lease-abc` cannot claim `lease-abcdef`.
 *
 * A server redirect (an auth gate, a locale redirect) drops the query string before the SDK loads, so
 * the marker never reaches the session. The last evidence left is the lease's own page: when the pool
 * can say where it is (`pageUrl`) and exactly one unmarked session sits on that URL, that session is
 * the lease's tab. Two sessions on it, or none, adopts nothing: a guess would drive someone else's tab.
 *
 * `before` is the ids already connected when the lease was acquired. None of those can be this lease's
 * tab, so a person's own tab sitting on the same URL is never adopted.
 */
export function resolveLeasedSessionId(
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  leaseId: string,
  pageUrl?: string,
  before?: ReadonlySet<string>,
): string | undefined {
  if (sessions.get(leaseId) !== undefined) return leaseId;
  const all = sessions.all();
  const marked = all.find((s) => sessionParamOf(s.url) === leaseId);
  if (marked !== undefined) return marked.id;
  const onPage = sessionsOnUnmarkedPage(all, pageUrl, before);
  return 1 === onPage.length ? onPage[0]?.id : undefined;
}

/** The ids of every session connected right now: take it before acquiring, pass it as `before`. */
export function connectedIds(sessions: { all?: () => { id: string }[] }): Set<string> {
  // `all` is optional only so a test double with a bare `get` still works; the real store has it.
  return new Set((sessions.all?.() ?? []).map((s) => s.id));
}

/**
 * The sessions sitting on `pageUrl` that no lease marked and that were not connected before the
 * lease. Empty when the page URL is unknown.
 */
function sessionsOnUnmarkedPage(
  all: { id: string; url?: string }[],
  pageUrl: string | undefined,
  before?: ReadonlySet<string>,
): { id: string; url?: string }[] {
  if (pageUrl === undefined) return [];
  return all.filter(
    (s) => s.url === pageUrl && sessionParamOf(s.url) === undefined && before?.has(s.id) !== true,
  );
}

/**
 * What to say when the lease matched no session but its page IS the address some session connected
 * from. The returned `sessionId` is then the lease id (release still needs it) and no tool accepts
 * it, so the hint has to name the id the tab did connect under. Empty unless exactly one session sits there.
 */
export function connectedUnderOtherIdNote(
  all: { id: string; url?: string }[],
  leaseId: string,
  pageUrl: string | undefined,
  before?: ReadonlySet<string>,
): string {
  const onPage = sessionsOnUnmarkedPage(all, pageUrl, before);
  const [only] = onPage;
  // Several sessions on one URL cannot be told apart, so none is named: pointing at one would be
  // the guess the resolver refuses to make.
  if (pageUrl === undefined || only === undefined || 1 !== onPage.length) return '';
  return `The lease id ${leaseId} names no session, but the leased tab is at ${pageUrl} and session ${only.id} connected there. Drive ${only.id}, not the lease id; release with the lease id. `;
}
