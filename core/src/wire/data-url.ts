/**
 * Inline-content URLs, summarised for a diagnostic.
 *
 * A `data:` URL IS its payload: an image generated in the page and fetched back arrives on the net
 * channel as `data:image/png;base64,` followed by every byte of the PNG. Reported from the field as
 * a successful `act_and_wait` whose blast radius carried one such URL in full, at a cost of tens of
 * thousands of tokens on a call that had nothing wrong to say. Nothing downstream of a diagnostic
 * can use the bytes; what it can use is the scheme, the media type and the size.
 *
 * Lives in core because the URL is reachable from more than one diagnostic and a fix in one of them
 * leaves the others. Every path that serialises a request URL for the agent calls this first.
 */

/** Scheme of a URL whose payload travels inline, RFC 2397. */
const DATA_URL_SCHEME = 'data:';
/** Scheme of a URL that names an in-memory object by an opaque id. */
const BLOB_URL_SCHEME = 'blob:';
/** The metadata/payload separator of a `data:` URL: everything after it is content. */
const DATA_URL_PAYLOAD_SEPARATOR = ',';
/** The origin/id separator of a `blob:` URL: everything after the last one is the object id. */
const BLOB_URL_ID_SEPARATOR = '/';
/** In-band sentinel over the elided span, carrying its size: `<…48219 bytes…>`. */
const ELIDED_OPEN = '<…';
const ELIDED_CLOSE = ' bytes…>';

function hasScheme(url: string, scheme: string): boolean {
  return url.slice(0, scheme.length).toLowerCase() === scheme;
}

function elided(bytes: number): string {
  return `${ELIDED_OPEN}${String(bytes)}${ELIDED_CLOSE}`;
}

/**
 * Replace a `data:` or `blob:` URL with a summary that keeps what a diagnostic can use and states
 * the size of what it dropped. Any other URL is returned byte-for-byte.
 *
 *   data:image/png;base64,iVBORw0KGgo…   →  data:image/png;base64,<…48219 bytes…>
 *   blob:https://app.example/3f1c-…      →  blob:https://app.example/<…36 bytes…>
 *
 * The media type survives on purpose — "the action fetched a PNG" is the diagnostic. The count is
 * the length of the elided text, so `data:text/plain,hello` and its percent-encoded twin both
 * report what they cost on the wire rather than a decoded size nobody can check against the URL.
 *
 * MARKER rather than REPORT: the summary stands in the `url` slot of strings such as
 * `net GET <url>` and `POST <url> 500`, where a report cannot ride beside the value, so the
 * sentinel is the declaration. It is unambiguous — no real URL contains `<…`.
 */
export function summarizeDataUrl(url: string): string {
  if (hasScheme(url, DATA_URL_SCHEME)) {
    const separator = url.indexOf(DATA_URL_PAYLOAD_SEPARATOR);
    const head = -1 === separator ? DATA_URL_SCHEME : url.slice(0, separator + 1);
    return `${head}${elided(url.length - head.length)}`;
  }
  if (hasScheme(url, BLOB_URL_SCHEME)) {
    const separator = url.lastIndexOf(BLOB_URL_ID_SEPARATOR);
    const head = separator < BLOB_URL_SCHEME.length ? BLOB_URL_SCHEME : url.slice(0, separator + 1);
    return `${head}${elided(url.length - head.length)}`;
  }
  return url;
}
