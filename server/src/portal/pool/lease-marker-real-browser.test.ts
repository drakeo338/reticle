/**
 * #1352 against a real Chromium: the real BrowserPool and Playwright launcher, a local server that
 * answers 302, and the assertion that the lease marker is in the leased page's location after the
 * redirect. Skipped cleanly when no Chromium is installed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import { BrowserPool } from './browser-pool.js';
import { playwrightLauncher } from './playwright-launcher.js';
import type { Launcher, PooledPage } from './pool-contract.js';

/** The real launcher, remembering every page it opens so a test can ask the page where it is. */
function recordingLauncher(pages: PooledPage[]): Launcher {
  const real = playwrightLauncher();
  return async () => {
    const browser = await real();
    return {
      ...browser,
      newContext: async () => {
        const context = await browser.newContext();
        return {
          ...context,
          newPage: async () => {
            const page = await context.newPage();
            pages.push(page);
            return page;
          },
        };
      },
    };
  };
}

const hrefOf = async (page: PooledPage | undefined): Promise<URL> =>
  new URL(String(await page?.evaluate?.('location.href')));

const SESSION = RETICLE_URL_PARAM.SESSION;

async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const available = await chromiumInstalled();

describe.skipIf(!available)('lease marker survives a real server redirect', () => {
  let server: http.Server;
  let origin: string;
  let pool: BrowserPool;
  let n = 0;
  const pages: PooledPage[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if ('/private' === path) {
        res.writeHead(302, { Location: '/login' }).end();
      } else if ('/a/b/deep' === path) {
        res.writeHead(302, { Location: '/a/login' }).end();
      } else {
        res.setHeader('content-type', 'text/html');
        res.end('<title>ok</title>');
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pool = new BrowserPool(recordingLauncher(pages), {
      maxContexts: 3,
      genSessionId: () => `lease-gen-${n++}`,
    });
  });

  afterAll(async () => {
    await pool?.shutdown();
    await new Promise<void>((ok) => server?.close(() => ok()));
  });

  const leaseUrl = (path: string, id: string): string => `${origin}${path}?${SESSION}=${id}`;

  it.each([
    ['/private', '/login'],
    ['/a/b/deep', '/a/login'],
  ])(
    '%s redirects to %s and keeps the lease marker',
    async (from, to) => {
      const id = `lease-real-${from.length}`;
      pages.length = 0;
      const lease = await pool.acquire(leaseUrl(from, id), { sessionId: id });
      const landed = await hrefOf(pages[0]);
      expect(landed.pathname).toBe(to);
      expect(landed.searchParams.get(SESSION)).toBe(id);
      await lease.release();
    },
    30_000,
  );

  it('concurrent leases each keep their own marker', async () => {
    pages.length = 0;
    const [a, b] = await Promise.all([
      pool.acquire(leaseUrl('/private', 'lease-a'), { sessionId: 'lease-a' }),
      pool.acquire(leaseUrl('/private', 'lease-b'), { sessionId: 'lease-b' }),
    ]);
    const markers = await Promise.all(
      pages.map(async (p) => (await hrefOf(p)).searchParams.get(SESSION)),
    );
    expect(markers.sort()).toEqual(['lease-a', 'lease-b']);
    await Promise.all([a.release(), b.release()]);
  }, 30_000);
});
