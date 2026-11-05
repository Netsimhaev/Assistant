/**
 * A minimal `multipart/form-data` reader for the one upload the dashboard
 * takes — "צרפי קובץ" beside the instruction box (document production D14).
 * Our own, deliberately small: no dependency for one form.
 *
 * **What it accepts, positively:** text fields, and AT MOST ONE file part.
 * A second file part is refused (`too_many_files`), never silently dropped:
 * the owner attached two things and would otherwise see one of them used.
 * A file part over `maxFileBytes` is refused (`file_too_large`) — the caller
 * passes the same cap the document ingest enforces, so nothing that ingest
 * would refuse is ever written to disk. A file input the owner left empty
 * (filename `""`, no bytes) is no file.
 *
 * **The filename is data, never a path.** It is returned exactly as the
 * browser sent it between the quotes — no `basename`, no normalisation, no
 * decoding of `..` — and the caller stores it as `original_name` and builds
 * every path it writes from ids of its own. `../../x.xlsx` is an inert string.
 *
 * Anything this reader does not understand — no boundary, a part with no
 * header block, a body with no closing delimiter — is `malformed`, refused
 * as a whole. The body is already bounded by the caller before it gets here.
 */

export interface MultipartFile {
  /** The form field name the file came in under. */
  field: string;
  /** Verbatim, as the browser sent it. Never a path. */
  filename: string;
  contentType: string | null;
  bytes: Buffer;
}

export type MultipartResult =
  | { ok: true; fields: Map<string, string>; file: MultipartFile | null }
  | { ok: false; code: 'malformed' | 'too_many_files' | 'file_too_large' };

/** The `boundary` parameter of a `multipart/form-data` content type, or `null`. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const [type, ...params] = contentType.split(';');
  if (type?.trim().toLowerCase() !== 'multipart/form-data') return null;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = param.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // RFC 2046: 1–70 characters from a closed set.
    return /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(value) ? value : null;
  }
  return null;
}

/** One `name="…"` / `filename="…"` parameter of a Content-Disposition header, unquoted. */
function dispositionParam(header: string, key: string): string | null {
  // `(?:^|;)\s*` so `name` never matches inside `filename`. Browsers do not
  // backslash-escape (WHATWG encodes `"` as `%22`), so a backslash is just a
  // character of the name and the quoted value runs to the next `"`.
  const re = new RegExp(`(?:^|;)\\s*${key}="([^"]*)"`, 'i');
  const quoted = re.exec(header);
  if (quoted?.[1] !== undefined) return quoted[1];
  const bare = new RegExp(`(?:^|;)\\s*${key}=([^;\\s]*)`, 'i').exec(header);
  return bare?.[1] ?? null;
}

export function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
  options: { maxFileBytes: number },
): MultipartResult {
  const boundary = boundaryOf(contentType);
  if (boundary === null) return { ok: false, code: 'malformed' };
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  let file: MultipartFile | null = null;

  let at = body.indexOf(delimiter);
  if (at < 0) return { ok: false, code: 'malformed' };
  for (;;) {
    let cursor = at + delimiter.length;
    // `--` straight after a delimiter closes the body.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) return { ok: true, fields, file };
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) return { ok: false, code: 'malformed' };
    cursor += 2;

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) return { ok: false, code: 'malformed' };
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headerEnd + 4);
    if (next < 0) return { ok: false, code: 'malformed' };

    const headers = body.subarray(cursor, headerEnd).toString('utf8').split('\r\n');
    const content = body.subarray(headerEnd + 4, next);
    let disposition: string | null = null;
    let partType: string | null = null;
    for (const line of headers) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      if (key === 'content-disposition') disposition = line.slice(colon + 1).trim();
      else if (key === 'content-type') partType = line.slice(colon + 1).trim();
    }
    if (disposition === null || !/^form-data\b/i.test(disposition)) return { ok: false, code: 'malformed' };
    const name = dispositionParam(disposition, 'name');
    if (name === null) return { ok: false, code: 'malformed' };
    const filename = dispositionParam(disposition, 'filename');

    if (filename === null) {
      fields.set(name, content.toString('utf8'));
    } else if (!(filename === '' && content.length === 0)) {
      if (file !== null) return { ok: false, code: 'too_many_files' };
      if (content.length > options.maxFileBytes) return { ok: false, code: 'file_too_large' };
      file = { field: name, filename, contentType: partType, bytes: Buffer.from(content) };
    }
    at = next + 2;
  }
}
