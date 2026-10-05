import { RETICLE_URL_PARAM } from '@reticlehq/core';
import type { PooledPage } from './pool-contract.js';

/** What the stamp needs to know; serialised into the page, so plain strings only. */
interface LeaseMarkerArg {
  session: string;
  project?: string | undefined;
  targetOrigin: string;
  sessionParam: string;
  projectParam: string;
}

/**
 * Runs in the leased page before any app script, on every document it loads, redirects included.
 *
 * The lease navigates to `url?__reticle_session=<lease id>` and the SDK registers under that id. A
 * server redirect (an auth gate, a locale redirect) drops the query string, so the SDK met a URL
 * with no marker and registered under its own id: the lease then named no session. This puts the
 * marker back on the document's URL (history.replaceState, no reload, no request) before the SDK
 * reads it, so the SDK registers under the lease id exactly as if nothing had redirected.
 *
 * The evidence is tied to the leased page itself: an init script runs only in pages of the lease's
 * own browser context, so a person's tab at the same URL never carries the marker and is never
 * matched. Top frame only, and only on the lease's target origin, so the lease id is not written
 * into an identity provider's or any third party's URL.
 *
 * Must stay self-contained: Playwright serialises the function source into the page.
 */
export function stampLeaseMarker(arg: LeaseMarkerArg): void {
  const win = (globalThis as unknown as { window?: unknown }).window as
    | {
        top?: unknown;
        location?: { href: string; origin: string };
        history?: { replaceState(state: unknown, title: string, url: string): void };
      }
    | undefined;
  if (win === undefined || win.top !== win || win.location === undefined) return;
  if (win.location.origin !== arg.targetOrigin) return;
  try {
    const url = new URL(win.location.href);
    if (url.searchParams.has(arg.sessionParam)) return;
    url.searchParams.set(arg.sessionParam, arg.session);
    if (arg.project !== undefined && !url.searchParams.has(arg.projectParam)) {
      url.searchParams.set(arg.projectParam, arg.project);
    }
    win.history?.replaceState(null, '', url.toString());
  } catch {
    // Best effort: without the marker the lease reports not-ready, which is the honest answer.
  }
}

/** Install the stamp on a lease's page; a page that cannot take init scripts keeps the URL marker only. */
export async function installLeaseMarker(
  page: PooledPage,
  leaseId: string,
  targetOrigin: string | undefined,
  project: string | undefined,
): Promise<void> {
  if (page.addInitScript === undefined || targetOrigin === undefined) return;
  const arg: LeaseMarkerArg = {
    session: leaseId,
    project,
    targetOrigin,
    sessionParam: RETICLE_URL_PARAM.SESSION,
    projectParam: RETICLE_URL_PARAM.PROJECT,
  };
  await page.addInitScript(stampLeaseMarker, arg);
}

/** The lease marker (and project) the URL carries, or undefined when it carries none. */
export function leaseMarkerOf(url: string): { session: string; project?: string } | undefined {
  try {
    const params = new URL(url).searchParams;
    const session = params.get(RETICLE_URL_PARAM.SESSION);
    if (null === session || 0 === session.length) return undefined;
    const project = params.get(RETICLE_URL_PARAM.PROJECT);
    return null === project || 0 === project.length ? { session } : { session, project };
  } catch {
    return undefined;
  }
}
