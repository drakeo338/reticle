import { describe, expect, it } from 'vitest';
import { getAccessibleName } from './a11y.js';

describe('name from content for roles that allow it', () => {
  // A segmented filter written as `<button role="radio">held</button>` is an extremely ordinary
  // design-system control. `radio` was missing from the name-from-content set, so six filters on a
  // shipments console reported as six nameless radios and `by: role` + name could not address any of
  // them — the agent had to fall back to a testid the app has no reason to carry.
  it.each(['radio', 'checkbox', 'row', 'tooltip', 'button', 'tab'])(
    'names a %s from its text content',
    (role) => {
      const el = document.createElement('div');
      el.setAttribute('role', role);
      el.textContent = 'held';
      expect(getAccessibleName(el)).toBe('held');
    },
  );

  it('still prefers an explicit aria-label over content', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'radio');
    el.setAttribute('aria-label', 'status: held');
    el.textContent = 'held';
    expect(getAccessibleName(el)).toBe('status: held');
  });
});

describe('aria-hidden decoration inside a label', () => {
  /**
   * The name we REPORT must be a name the agent can then MATCH on.
   *
   * `by: role` matching must use this same computed name. A previous split implementation excluded
   * `aria-hidden` subtrees while this function read the label's raw `textContent`, so MUI's
   * required-field marker (`<span aria-hidden="true"> *</span>`) made us report `"Username *"` for
   * a field that was only addressable as `"Username"`.
   *
   * Measured on the react-admin demo login form: `reticle_query` reported the textbox as
   * `name: "Username *"`, and querying that exact string back returned ZERO elements while
   * `"Username"` returned one. An agent that reads a name out of a snapshot and uses it — the whole
   * point of reporting names — got nothing, on a pattern every Material UI form emits.
   */
  it('ignores an aria-hidden required marker, matching the spec-computed name', () => {
    const label = document.createElement('label');
    label.htmlFor = 'u';
    label.append('Username');
    const marker = document.createElement('span');
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = ' *';
    label.append(marker);
    const input = document.createElement('input');
    input.id = 'u';
    document.body.append(label, input);
    try {
      expect(getAccessibleName(input)).toBe('Username');
    } finally {
      label.remove();
      input.remove();
    }
  });

  /**
   * The path that actually runs for Material UI, and the one the first fix missed.
   *
   * `getAccessibleName` tries `aria-labelledby` BEFORE the `labels` collection, and MUI's TextField
   * links its label that way — so patching the labels path alone changed nothing on the real app, and
   * the fix looked applied while the symptom persisted. Verified against the installed MUI source:
   * `FormLabel` renders its required marker as `<span aria-hidden="true">{'\u2009'}*</span>`.
   */
  it('ignores an aria-hidden marker reached through aria-labelledby', () => {
    const label = document.createElement('label');
    label.id = 'lbl';
    label.append('Username');
    const marker = document.createElement('span');
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '\u2009*';
    label.append(marker);
    const input = document.createElement('input');
    input.setAttribute('aria-labelledby', 'lbl');
    document.body.append(label, input);
    try {
      expect(getAccessibleName(input)).toBe('Username');
    } finally {
      label.remove();
      input.remove();
    }
  });

  it('ignores aria-hidden content when naming from content too', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    el.append('Save');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ' ✓';
    el.append(icon);
    expect(getAccessibleName(el)).toBe('Save');
  });
});

describe('label for> on a labelable element other than input/textarea/select', () => {
  /**
   * `<button>` is a labelable element (as are `<meter>`, `<output>` and `<progress>`), and a native
   * `<label for>` outranks the button's own content in the name computation. `el.labels` was only
   * read inside the input/textarea/select guard, so a select-style trigger built as
   * `<button role="combobox">` with a `<label for>` fell through to naming from its own text content
   * instead - `{ role: "combobox", name: "…" }` found nothing and targeting had to fall back to refs.
   */
  it("prefers a native label over a button's own content", () => {
    const label = document.createElement('label');
    label.htmlFor = 'plan';
    label.append('Plan');
    const button = document.createElement('button');
    button.id = 'plan';
    button.setAttribute('role', 'combobox');
    button.append('Choose…');
    document.body.append(label, button);
    try {
      expect(getAccessibleName(button)).toBe('Plan');
    } finally {
      label.remove();
      button.remove();
    }
  });

  it('names a plain button from its label', () => {
    const label = document.createElement('label');
    label.htmlFor = 'b';
    label.append('Save draft');
    const button = document.createElement('button');
    button.id = 'b';
    button.append('Save');
    document.body.append(label, button);
    try {
      expect(getAccessibleName(button)).toBe('Save draft');
    } finally {
      label.remove();
      button.remove();
    }
  });

  it.each(['meter', 'output', 'progress'])(
    'names a %s from a native label, not its own content',
    (tag) => {
      const label = document.createElement('label');
      label.htmlFor = 'm';
      label.append('Disk usage');
      const el = document.createElement(tag);
      el.id = 'm';
      document.body.append(label, el);
      try {
        expect(getAccessibleName(el)).toBe('Disk usage');
      } finally {
        label.remove();
        el.remove();
      }
    },
  );
});

describe('the labels read is scoped to labelable elements', () => {
  /**
   * `getAccessibleName` runs over every element a snapshot walks, not only form fields, so it meets
   * arbitrary elements - including custom elements an app defines with its own `labels` property for
   * its own purposes (a tag list, a chart's category labels, ...). A `<div role="radio">` is not
   * labelable per the HTML spec, so this read must never touch `.labels` on it at all: a hostile
   * getter that throws, or a `.labels` that isn't a NodeList, must not break naming for elements this
   * function has no business reading `.labels` from in the first place.
   */
  it('does not throw and falls back to content when a non-labelable element has a hostile labels property', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'radio');
    el.textContent = 'held';
    Object.defineProperty(el, 'labels', {
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => getAccessibleName(el)).not.toThrow();
    expect(getAccessibleName(el)).toBe('held');
  });
});
