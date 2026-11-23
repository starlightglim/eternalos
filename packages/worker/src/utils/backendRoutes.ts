/**
 * Best-effort route discovery for a full-stack app's server.js.
 *
 * The assistant calls an app's backend through callAppApi/readAppApi, and in
 * live runs the model otherwise guesses paths ("/api/log" for an app that
 * serves "/api/entries") — burning an approval on a 404 before it reads the
 * source. listApps returns these hints so the first call uses a real route.
 *
 * Heuristic, not a parser: it finds `/api/...` path literals (strings, and
 * regex literals like /^\/api\/todos\/(\d+)$/), and attaches an HTTP method
 * when one is compared or used as a router call within the same statement
 * neighbourhood. Unknown methods are reported as a bare path.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MAX_ROUTES = 24;

/** Turn a regex-literal body like `^\/api\/todos\/(\d+)$` into `/api/todos/:id`. */
function regexToPath(body: string): string {
  return body
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\([^)]*\)/g, ':id')
    .replace(/\\d\+|\\w\+|\[\^\/\]\+/g, ':id')
    .replace(/[?]$/, '');
}

function nearbyMethods(code: string, index: number, length: number): string[] {
  // Look at the same line plus a short window either side — enough for
  // `if (url.pathname === '/api/x' && request.method === 'POST')` and
  // `router.post('/api/x', ...)`, without reaching the next route's branch.
  const lineStart = code.lastIndexOf('\n', index) + 1;
  const lineEndIdx = code.indexOf('\n', index + length);
  const line = code.slice(lineStart, lineEndIdx < 0 ? code.length : lineEndIdx);
  const found = new Set<string>();
  for (const method of METHODS) {
    const quoted = new RegExp(`['"\`]${method}['"\`]`);
    const routerCall = new RegExp(`\\.${method.toLowerCase()}\\s*\\(`);
    if (quoted.test(line) || routerCall.test(line)) found.add(method);
  }
  return [...found];
}

export function extractBackendRoutes(files: Record<string, string>): string[] {
  const routes: string[] = [];
  const seen = new Set<string>();
  const add = (route: string) => {
    if (seen.has(route) || routes.length >= MAX_ROUTES) return;
    seen.add(route);
    routes.push(route);
  };

  const backendFiles = Object.entries(files).filter(([name]) => name === 'server.js' || name.startsWith('server/'));
  for (const [, code] of backendFiles) {
    if (typeof code !== 'string') continue;
    const patterns: Array<[RegExp, (m: RegExpExecArray) => string]> = [
      [/(['"`])(\/api(?:\/[^'"`\s${}]*)?)\1/g, (m) => m[2]],
      [/\/(\^?\\\/api(?:\\.|[^/\\\n])*)\/[gimsuy]*/g, (m) => regexToPath(m[1])],
    ];
    for (const [re, toPath] of patterns) {
      for (let m = re.exec(code); m; m = re.exec(code)) {
        const path = toPath(m).replace(/\/+$/, '') || '/api';
        if (path === '/api') continue;
        const methods = nearbyMethods(code, m.index, m[0].length);
        if (methods.length) for (const method of methods) add(`${method} ${path}`);
        else add(path);
      }
    }
  }

  // Drop a bare path when the same path is also known with a method.
  return routes.filter((route) => route.includes(' ') || !routes.some((other) => other.endsWith(` ${route}`)));
}

/**
 * JSON body fields a backend reads from `await request.json()` — both
 * `body.text` member access and `const { text, done } = await request.json()`
 * destructuring. Without this the model guesses ({ message } instead of
 * { text }) and the user approves a write that comes back 400.
 */
export function extractBackendBodyFields(files: Record<string, string>): string[] {
  const fields = new Set<string>();
  const backendFiles = Object.entries(files).filter(([name]) => name === 'server.js' || name.startsWith('server/'));
  for (const [, code] of backendFiles) {
    if (typeof code !== 'string') continue;
    for (const m of code.matchAll(/\{([^{}]{1,300})\}\s*=\s*await\s+request\.json\s*\(/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[\s:=]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) fields.add(name);
      }
    }
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*await\s+request\.json\s*\(/g)) {
      const variable = m[1];
      const access = new RegExp(`\\b${variable.replace(/\$/g, '\\$')}\\??\\.([A-Za-z_$][\\w$]*)`, 'g');
      for (const a of code.matchAll(access)) fields.add(a[1]);
    }
  }
  return [...fields].filter((name) => name !== 'json').slice(0, 20);
}
