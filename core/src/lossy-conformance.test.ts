import { describe, expect, it } from 'vitest';
import { capDepth, selectPath, projectComponentState } from './wire/state-select.js';
import { toToon, resultToToon } from './wire/toon.js';
import { summarizeDataUrl } from './wire/data-url.js';

/**
 * Conformance half of the lossy-transform invariant, for the transforms that live in core.
 *
 *   Any transform that can drop, truncate, or shape-coerce data on a path an agent reads must
 *   report that it did, in a machine-readable way the consumer can detect.
 *
 * Each case drives a fixture GUARANTEED to lose data and asserts the loss is declared. The
 * completeness half — that every export of a read-path module has been classified at all — is
 * `scripts/check-lossy-transforms.mjs`, which runs in `pnpm lint`.
 *
 * The value here is not the assertions. It is that adding a transform to one of these modules now
 * forces someone to answer the question.
 */

describe('capDepth declares its loss with a sized marker', () => {
  // MARKER rather than REPORT: the caller asked for a depth cap, so the collapse is requested, and
  // the value's SHAPE has to survive it — a report spliced into the value would break the schema of
  // the very payloads already under pressure. What matters is that the sentinel states the size, so
  // "collapsed" is never mistakable for "empty".
  it.each([
    ['an array', [1, 2, 3, 4, 5], '[Array(5)]'],
    ['an object', { a: 1, b: 2, c: 3 }, '{…3 keys}'],
    ['a Set', new Set(['a', 'b']), '[Set(2)]'],
    ['a Map', new Map([['a', 1]]), '{Map(1)}'],
  ])('collapses %s to a marker carrying its size', (_label, value, marker) => {
    expect(capDepth(value, 0)).toBe(marker);
  });

  it('never collapses a collection to an empty one, which would read as "there was nothing"', () => {
    const collapsed = capDepth({ rows: [1, 2, 3] }, 1) as Record<string, unknown>;
    expect(collapsed['rows']).toBe('[Array(3)]');
    expect(collapsed['rows']).not.toEqual([]);
  });

  it('declares nothing when nothing was lost', () => {
    expect(capDepth({ a: { b: 1 } }, 5)).toEqual({ a: { b: 1 } });
  });
});

describe('selectPath declares its loss beside the value', () => {
  it('reports a miss rather than returning a bare null', () => {
    const selection = selectPath({ cart: { items: 1 } }, 'cart.total');
    expect(selection.found).toBe(false);
    expect(selection.availableKeys).toEqual(['items']);
  });

  it('says how many keys there really were when the near-miss list is a SAMPLE', () => {
    // The false green this closes: 50 names and no marker reads as "the key you asked for does not
    // exist" — the strongest negative signal there is — when the key is simply number 51.
    const big: Record<string, number> = {};
    for (let i = 0; i < 500; i++) big[`key${String(i)}`] = i;
    const selection = selectPath(big, 'nope');

    expect(selection.availableKeys?.length).toBe(50);
    expect(selection.totalKeys).toBe(500);
  });

  it.each([
    [
      'an object',
      Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${String(i)}`, i])),
      120,
    ],
    // 121, not 120: `length` is a selectable segment on an array, so it counts as available.
    ['an array', Array.from({ length: 120 }, (_, i) => i), 121],
    ['a Map', new Map(Array.from({ length: 120 }, (_, i) => [`k${String(i)}`, i])), 120],
  ])('reports the true size for %s', (_label, value, total) => {
    expect(selectPath(value, 'definitely-not-here').totalKeys).toBe(total);
  });

  it('omits totalKeys when the list is complete, so its presence always MEANS something', () => {
    expect(selectPath({ a: 1 }, 'b').totalKeys).toBeUndefined();
  });
});

describe('toToon declares a collapsed subtree with its size', () => {
  it('carries count=N for a container whose children are not expanded', () => {
    const encoded = toToon([{ ref: 'e1', role: 'list', name: 'Results', childCount: 250 }]);
    expect(encoded).toContain('count=250');
  });

  it('states the count even when it is the only thing distinguishing empty from collapsed', () => {
    const collapsed = toToon([{ ref: 'e1', role: 'list', name: 'Results', childCount: 0 }]);
    expect(collapsed).toContain('count=0');
  });

  it('passes a non-element result through rather than encoding it to nothing', () => {
    // resultToToon on a payload with no `elements` array must not silently produce an empty tree —
    // that would turn "this is not a snapshot" into "the snapshot was empty".
    expect(resultToToon({ verdict: 'pass' })).toBe(JSON.stringify({ verdict: 'pass' }));
  });
});

describe('projectComponentState declares the hooks it dropped', () => {
  const effect = {
    tag: 9,
    create: null,
    deps: ['', false],
    inst: { destroy: null },
    next: null,
  };

  it('reports droppedItems + a note when effect hooks are removed', () => {
    const projected = projectComponentState({ ok: true, hooks: [1, effect, effect] }) as {
      hooks: unknown[];
      truncation?: { droppedItems: number; note: string };
    };
    expect(projected.hooks).toEqual([1]); // the two effect entries are gone
    expect(projected.truncation?.droppedItems).toBe(2);
    expect(projected.truncation?.note).toContain('effect');
  });

  it('says nothing when nothing was dropped (the marker IS the warning)', () => {
    const intact = { ok: true, hooks: [1, 'two', { current: null }] };
    expect(projectComponentState(intact)).toEqual(intact);
  });
});

describe('summarizeDataUrl declares the payload it dropped with a sized marker', () => {
  // MARKER rather than REPORT: the summary stands in the `url` slot of a diagnostic string, where
  // nothing can ride beside it. What survives is what a reader can use — scheme and media type —
  // and the marker states how much was behind them, so a summarised PNG is never mistakable for
  // an empty one.
  it('keeps the media type and states the size of the elided payload', () => {
    const payload = 'A'.repeat(48219);
    expect(summarizeDataUrl(`data:image/png;base64,${payload}`)).toBe(
      'data:image/png;base64,<…48219 bytes…>',
    );
  });

  it('bounds a blob: URL the same way, keeping the origin', () => {
    const summary = summarizeDataUrl(
      'blob:https://app.example/8b1d3c2a-7f4e-4d1a-9c0b-2e5f6a7b8c9d',
    );
    expect(summary).toBe('blob:https://app.example/<…36 bytes…>');
  });

  it('matches the scheme regardless of case, as the browser does', () => {
    expect(summarizeDataUrl('DATA:text/plain,hello')).toBe('DATA:text/plain,<…5 bytes…>');
  });

  it('still marks a data: URL with no payload separator, rather than passing the bytes through', () => {
    expect(summarizeDataUrl('data:image/png;base64')).toBe('data:<…16 bytes…>');
  });

  it('returns every other URL byte-for-byte, so the marker always MEANS something', () => {
    for (const url of ['/api/order', 'https://api.example/v1?x=1', 'ipc://get_user', '']) {
      expect(summarizeDataUrl(url)).toBe(url);
    }
  });
});
