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
 * the marker never reaches the session and nothing proves whose tab it is. That is NOT adopted: a
 * person opening the same URL in the same window is indistinguishable from the lease's tab, and
 * driving it would drive someone else's browser. The lease stays not-ready and the hint names the
 * candidate (see `connectedUnderOtherIdNote`) for the agent to confirm.
 */
export function resolveLeasedSessionId(
  sessions: { get: (id: string) => unknown; all: () => { id: string; url?: string }[] },
  leaseId: string,
): string | undefined {
  if (sessions.get(leaseId) !== undefined) return leaseId;
  return sessions.all().find((s) => sessionParamOf(s.url) === leaseId)?.id;
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

/** Unverified on purpose: nothing proves the session is the lease's tab and not a person's. */
const connectedUnderOtherIdMessage = (leaseId: string, pageUrl: string, id: string): string =>
  `The lease id ${leaseId} names no session, and the lease was NOT bound to one. Session ${id} connected at ${pageUrl}, the leased tab's address, but it carries no lease marker so it may be a person's tab, not the lease's. Drive it only if you know it is yours; release with the lease id. `;

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
  return connectedUnderOtherIdMessage(leaseId, pageUrl, only.id);
}
