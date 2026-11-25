/**
 * Web reading for Ask Eternal (readWebPage): which URLs may be opened, and
 * turning a fetched page into plain text the model can read.
 *
 * Safety model:
 * - Only public http(s) pages on the default ports: no localhost, private
 *   or link-local IPs, single-label hosts, or EternalOS's own hosts.
 * - The assistant may open only URLs the user wrote in the chat, or links
 *   found on pages it already opened for them (exact match, query string
 *   included). A page or note that says "fetch https://evil.example/?data=…"
 *   cannot get the model to send the user's data out through a URL.
 * - Page text is untrusted data. The tool result says so; writes still go
 *   through previews and approval like any other change.
 */

export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_TEXT_CHARS = 15_000;
export const MAX_LINKS = 40;
/** HTML beyond this is not parsed (the readable start of any page fits easily). */
export const MAX_PARSE_CHARS = 512 * 1024;

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];
const OWN_HOST_RE = /(^|\.)eternalos\.me$|eternalos-api/i;

function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Is this a public web page we are willing to fetch? */
export function checkWebUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https pages can be read.' };
  }
  if (url.username || url.password) return { ok: false, reason: 'Links with a username or password are not opened.' };
  if (url.port && url.port !== '80' && url.port !== '443') {
    return { ok: false, reason: 'Only pages on the standard web ports can be read.' };
  }
  const host = url.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.startsWith('[') ||
    !host.includes('.') ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isPrivateIPv4(host)
  ) {
    return { ok: false, reason: 'Private or local addresses cannot be read.' };
  }
  if (OWN_HOST_RE.test(host)) return { ok: false, reason: "EternalOS's own pages are not read through the web reader." };
  return { ok: true, url };
}

/**
 * The comparison key for "may the assistant open this URL": scheme, hash,
 * default port, host case and a trailing slash don't matter; path and query
 * string must match exactly.
 */
export function urlKey(raw: string): string | null {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
    return `${url.hostname.toLowerCase()}${path}${url.search}`;
  } catch {
    return null;
  }
}

const TRAILING_PUNCT_RE = /[).,;:!?'"\]>}]+$/;
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\/[^\s<>"'`]*/gi;

// Bare site names ("nytimes.com") count only on common endings, so file
// names like "notes.txt" or "readme.md" are not taken for web addresses.
const BARE_DOMAIN_RE = /(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|dev|app|co|edu|gov|ai|me|uk|us|ca|au|de|fr|es|it|nl|jp|news|blog|info|wiki|tv)(?![\w/.-]*\w)/gi;

/** Web addresses a person wrote in chat text ("https://…", "www.…", "site.com/path", "site.com"). */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text ?? '').matchAll(URL_IN_TEXT_RE)) {
    let candidate = match[0];
    // Keep a closing ")" that belongs to the URL (wiki links).
    while (TRAILING_PUNCT_RE.test(candidate)) {
      const last = candidate.at(-1)!;
      if (last === ')' && candidate.split('(').length > candidate.split(')').length - 1) break;
      candidate = candidate.slice(0, -1);
    }
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    found.push(candidate);
  }
  const rest = String(text ?? '').replace(URL_IN_TEXT_RE, ' ');
  for (const match of rest.matchAll(BARE_DOMAIN_RE)) found.push(`https://${match[0]}`);
  return [...new Set(found)];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•', times: '×', frac12: '½', frac14: '¼', frac34: '¾',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') : undefined;
}

function metaContent(html: string, key: string): string | undefined {
  for (const match of html.matchAll(/<meta\b[^<>]*>/gi)) {
    const tag = match[0];
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    if (name === key) return attr(tag, 'content')?.trim() || undefined;
  }
  return undefined;
}

// Page HTML is hostile input, so everything below runs in linear time:
// no backtracking `[\s\S]*?…<\/\1>` patterns (an attacker page full of
// unclosed `<script` or `<a` tags would make those quadratic), only
// forward scans that never revisit text.

/** Index of the next `</tag` at or after `from`, or -1. */
function findClose(html: string, tag: string, from: number): number {
  const re = new RegExp(`</${tag}\\b`, 'gi');
  re.lastIndex = from;
  return re.exec(html)?.index ?? -1;
}

/** Remove `<tag …>…</tag>` blocks; an unclosed block runs to the end (like a browser's <script>). */
function removeBlocks(html: string, tags: string[]): string {
  const openRe = new RegExp(`<(${tags.join('|')})\\b`, 'gi');
  let out = '';
  let kept = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html))) {
    out += html.slice(kept, match.index) + ' ';
    const close = findClose(html, match[1], openRe.lastIndex);
    if (close === -1) return out;
    const end = html.indexOf('>', close);
    kept = end === -1 ? html.length : end + 1;
    openRe.lastIndex = kept;
  }
  return out + html.slice(kept);
}

/** Inner HTML from the first `<tag …>` to the last `</tag`, or null. */
function outerBlockInner(html: string, tags: string[]): string | null {
  const open = new RegExp(`<(${tags.join('|')})\\b[^<>]*>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const closeRe = new RegExp(`</${open[1]}\\b`, 'gi');
  closeRe.lastIndex = start;
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = closeRe.exec(html))) last = match.index;
  return last === -1 ? null : html.slice(start, last);
}

/** Inner HTML of the first `<tag>…</tag>`, or null. */
function firstBlockInner(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}\\b[^<>]*>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = findClose(html, tag, start);
  return close === -1 ? null : html.slice(start, close);
}

/** Drop `<!-- … -->` comments; an unclosed one runs to the end. */
function removeComments(html: string): string {
  let out = '';
  let kept = 0;
  for (let open = html.indexOf('<!--'); open !== -1; open = html.indexOf('<!--', kept)) {
    out += html.slice(kept, open) + ' ';
    const close = html.indexOf('-->', open + 4);
    if (close === -1) return out;
    kept = close + 3;
  }
  return out + html.slice(kept);
}

const DROP_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'select', 'button', 'form'];
const CHROME_TAGS = ['nav', 'footer', 'header', 'aside'];

/** `<hN>…</hN>` → `# …` lines. Remembers where each level's next close is, so unclosed headings stay linear. */
function markHeadings(html: string): string {
  const openRe = /<h([1-6])\b[^<>]*>/gi;
  const nextClose = new Map<string, number>();
  let out = '';
  let kept = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html))) {
    const level = match[1];
    let close = nextClose.get(level);
    if (close === undefined || (close !== -1 && close < openRe.lastIndex)) {
      close = findClose(html, `h${level}`, openRe.lastIndex);
      nextClose.set(level, close);
    }
    if (close === -1) continue;
    const end = html.indexOf('>', close);
    out += `${html.slice(kept, match.index)}\n\n${'#'.repeat(Number(level))} ${stripTags(html.slice(openRe.lastIndex, close))}\n\n`;
    kept = end === -1 ? html.length : end + 1;
    openRe.lastIndex = kept;
  }
  return out + html.slice(kept);
}

function blockText(html: string): string {
  return decodeEntities(
    markHeadings(removeComments(html))
      .replace(/<li\b[^<>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)\s*>/gi, ' | ')
      .replace(/<\/?(p|div|section|article|main|tr|table|ul|ol|blockquote|pre|figure|figcaption|dl|dt|dd|hr)\b[^<>]*>/gi, '\n')
      .replace(/<[^<>]*>/g, ''),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PageLink { text: string; url: string }

export interface ExtractedPage {
  title: string;
  description?: string;
  text: string;
  truncated: boolean;
  links: PageLink[];
}

/** Readable text, title and links from an HTML page. */
export function extractPage(rawHtml: string, baseUrl: string, maxChars = MAX_TEXT_CHARS): ExtractedPage {
  const html = rawHtml.length > MAX_PARSE_CHARS ? rawHtml.slice(0, MAX_PARSE_CHARS) : rawHtml;
  const titleInner = firstBlockInner(html, 'title');
  const title = metaContent(html, 'og:title') ?? (titleInner !== null ? stripTags(titleInner.slice(0, 2000)) : '');
  const description = metaContent(html, 'description') ?? metaContent(html, 'og:description');

  const body = removeBlocks(outerBlockInner(html, ['body']) ?? removeBlocks(html, ['head']), DROP_TAGS);

  // Prefer the article/main content when it holds most of the page.
  const main = outerBlockInner(body, ['article', 'main']);
  let text = main !== null ? blockText(removeBlocks(main, CHROME_TAGS)) : '';
  if (text.length < 400) text = blockText(removeBlocks(body, CHROME_TAGS));
  if (text.length < 200) text = blockText(body);

  const links: PageLink[] = [];
  const seen = new Set<string>();
  const openRe = /<a\b([^<>]*)>/gi;
  let match: RegExpExecArray | null;
  while (links.length < MAX_LINKS && (match = openRe.exec(body))) {
    const close = findClose(body, 'a', openRe.lastIndex);
    if (close === -1) break;
    const inner = body.slice(openRe.lastIndex, close);
    openRe.lastIndex = close;
    const href = attr(match[1], 'href');
    if (!href || href.startsWith('#')) continue;
    let absolute: string;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      resolved.hash = '';
      absolute = resolved.href;
    } catch {
      continue;
    }
    const label = stripTags(inner.slice(0, 2000)).slice(0, 100);
    if (!label || seen.has(absolute)) continue;
    seen.add(absolute);
    links.push({ text: label, url: absolute });
  }

  const truncated = text.length > maxChars || html.length < rawHtml.length;
  return {
    title: title.slice(0, 300),
    ...(description ? { description: description.slice(0, 500) } : {}),
    text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
    truncated,
    links,
  };
}
