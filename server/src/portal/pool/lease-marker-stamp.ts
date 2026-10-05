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
 * Init script: a server redirect drops the `?__reticle_session=` marker, so this restores it with
 * history.replaceState before the SDK reads it. Top frame, lease target origin only. Must stay
 * self-contained: Playwright serialises the function source into the page.
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
