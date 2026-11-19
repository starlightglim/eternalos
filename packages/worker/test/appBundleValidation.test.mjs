/**
 * Unit tests for the deterministic post-bundle app validator
 * (src/utils/appBundleValidation.ts).
 *
 * These run in plain Node (type-stripping imports the .ts module directly —
 * same technique as the frontend suite's TS imports) so every check is
 * exercised without booting wrangler. The dev-deploy integration tests in
 * worker.integration.test.mjs cover the wired pipeline (400 + structured
 * issues) end to end.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// This suite runs in plain Node (type stripping, no bundler). The module
// under test imports its sibling with the project's TS-style extensionless
// form (`'./fsPolicy'`), which plain-Node ESM cannot resolve on its own — so
// use the shared test hooks (tsModuleHooks.mjs, introduced for the agent
// sources): they map extensionless relative specifiers to the sibling .ts
// file. Hooks are per-process, registered before the first dynamic import.
register(new URL('./tsModuleHooks.mjs', import.meta.url));

const {
  AppValidationError,
  assertAppBundleValid,
  collectAppBundleIssues,
  formatAppValidationIssues,
  scanScript,
} = await import('../src/utils/appBundleValidation.ts');
const { buildTodoTemplate } = await import('./fixtures/apps/templates/appTemplates.ts');

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_ROOT = path.join(TEST_ROOT, 'test', 'fixtures', 'apps');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(name) {
  const dir = path.join(FIXTURES_ROOT, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const files = {};
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'manifest.json' || entry === 'expect.json') continue;
    files[entry] = fs.readFileSync(path.join(dir, entry), 'utf8');
  }
  const expectPath = path.join(dir, 'expect.json');
  const expect = fs.existsSync(expectPath) ? JSON.parse(fs.readFileSync(expectPath, 'utf8')) : null;
  return { name, manifest, files, expect };
}

function inputFor(fixture, overrides = {}) {
  return {
    files: fixture.files,
    manifest: {
      entryHtml: 'index.html',
      sourceFiles: Object.keys(fixture.files).sort(),
      runtimeAsset: 'eternal-runtime.js',
      workerEntrypoint: '__eternal_worker__.js',
    },
    permissions: fixture.manifest.permissions,
    ...overrides,
  };
}

/** Build a validation input from raw files, bypassing fixture manifests. */
function appInput(files, permissions, overrides = {}) {
  return {
    files,
    manifest: {
      entryHtml: 'index.html',
      sourceFiles: Object.keys(files).sort(),
      runtimeAsset: 'eternal-runtime.js',
      workerEntrypoint: '__eternal_worker__.js',
    },
    permissions,
    ...overrides,
  };
}

function codesOf(issues) {
  return issues.map((issue) => issue.code);
}

const HTML = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

// ---------------------------------------------------------------------------
// Reference + negative fixtures
// ---------------------------------------------------------------------------

describe('app fixture validation', () => {
  it('accepts the Photo Grid reference app with no issues', () => {
    const photoGrid = loadFixture('photo-grid');
    const issues = collectAppBundleIssues(inputFor(photoGrid));
    assert.deepEqual(issues, [], `expected Photo Grid to pass validation, got: ${JSON.stringify(issues, null, 2)}`);
    assert.doesNotThrow(() => assertAppBundleValid(inputFor(photoGrid)));
  });

  it('rejects every negative fixture with its declared error code', () => {
    const negativeDirs = fs.readdirSync(FIXTURES_ROOT).filter((dir) => {
      const expectPath = path.join(FIXTURES_ROOT, dir, 'expect.json');
      return fs.existsSync(expectPath) && dir !== 'photo-grid';
    });
    assert.ok(negativeDirs.length >= 8, 'expected at least eight negative fixtures');

    for (const dir of negativeDirs) {
      const fixture = loadFixture(dir);
      const issues = collectAppBundleIssues(inputFor(fixture));
      const codes = codesOf(issues);
      assert.ok(
        codes.includes(fixture.expect.code),
        `${dir}: expected issue ${fixture.expect.code}, got ${JSON.stringify(codes)}`,
      );
      for (const issue of issues) {
        assert.ok(issue.message.length > 0, `${dir}: issue ${issue.code} has no message`);
      }
      if (fixture.expect.messageRegex) {
        const match = issues.find((issue) => issue.code === fixture.expect.code);
        assert.match(match.message, new RegExp(fixture.expect.messageRegex));
      }
      assert.throws(
        () => assertAppBundleValid(inputFor(fixture)),
        (error) => error instanceof AppValidationError && codesOf(error.issues).includes(fixture.expect.code),
        `${dir}: assertAppBundleValid should throw AppValidationError`,
      );
    }
  });

  it('rejects the curated todo template if it ever returns to browser storage', () => {
    // Regression for the real bug the validator surfaced: the shipped todo
    // template used localStorage, which throws a SecurityError in the
    // opaque-origin app iframe — every save broke. The migrated template
    // must pass validation.
    const todo = buildTodoTemplate('Tasks', 'regression');
    assert.deepEqual(collectAppBundleIssues(appInput(todo.files)), []);
    assert.doesNotThrow(() => assertAppBundleValid(appInput(todo.files)));
  });
});

// ---------------------------------------------------------------------------
// Bridge contract
// ---------------------------------------------------------------------------

describe('bridge contract checks', () => {
  it('rejects unknown namespaces and methods', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script src="app.js"></script>'),
      'app.js': 'window.eternal.ai.chat("hi");\nwindow.eternal.fs.save("/notes.txt", "x");',
    }));
    assert.deepEqual(codesOf(issues), ['bridge/unknown-namespace', 'bridge/unknown-method']);
    assert.match(issues[0].message, /eternal\.ai does not exist/);
    assert.match(issues[1].message, /eternal\.fs\.save does not exist/);
    assert.match(issues[1].hint, /list, read, readText/);
  });

  it('accepts every documented bridge member', () => {
    const files = {
      'index.html': HTML('<script type="module" src="app.js"></script>'),
      'app.js': [
        'window.eternal.fs.list({}).then(() => {});',
        'window.eternal.fs.read("id").then(() => {});',
        'window.eternal.fs.readText("id").then(() => {});',
        'window.eternal.fs.readJson("id").then(() => {});',
        'window.eternal.fs.urlFor("id");',
        'window.eternal.profile.get().then(() => {});',
        'window.eternal.window.setTitle("t");',
        'window.eternal.window.close();',
        'window.eternal.window.requestFocus();',
        'window.eternal.window.resize(600, 400);',
        'window.eternal.onIntent(() => {});',
        'window.eternal.storage.get("k").then(() => {});',
        'window.eternal.storage.set("k", 1).then(() => {});',
        'window.eternal.storage.delete("k").then(() => {});',
        'window.eternal.storage.list().then(() => {});',
        'window.eternal.ipc.emit("music.now_playing", {});',
        'window.eternal.ipc.on("music.now_playing", () => {});',
        'window.eternal.fetch("https://api.example.com/x").then(() => {});',
      ].join('\n'),
    };
    const issues = collectAppBundleIssues(appInput(files, {
      fs: { read: ['/**'] },
      profile: { read: ['username'] },
      network: { outbound: ['api.example.com'] },
      ipc: { emit: ['music.now_playing'], listen: ['music.now_playing'] },
    }));
    assert.deepEqual(issues, [], `expected clean bridge usage, got: ${JSON.stringify(issues)}`);
  });
});

// ---------------------------------------------------------------------------
// Permission coverage
// ---------------------------------------------------------------------------

describe('permission coverage checks', () => {
  const htmlShell = HTML('<script src="app.js"></script>');

  it('flags fs.list paths outside the declared read globs', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': "window.eternal.fs.list({ path: '/Documents' }).then(() => {});",
    }, { fs: { read: ['/Photos/**'] } }));
    assert.deepEqual(codesOf(issues), ['permission/fs-read-uncovered']);
    assert.match(issues[0].message, /\/Documents.*not covered/);
    assert.match(issues[0].message, /\/Photos\/\*\*/);
  });

  it('accepts fs.list paths inside the declared globs', () => {
    const cases = [
      [{ fs: { read: ['/**'] } }, "window.eternal.fs.list({ path: '/' }).then(() => {});"],
      [{ fs: { read: ['/Photos/**'] } }, "window.eternal.fs.list({ path: '/Photos' }).then(() => {});"],
      [{ fs: { read: ['/Photos/**'] } }, "window.eternal.fs.list({ path: '/Photos/sunrise.jpg' }).then(() => {});"],
      [{ fs: { mimeTypes: ['image/*'] } }, "window.eternal.fs.list({ path: '/Anywhere' }).then(() => {});"],
    ];
    for (const [permissions, line] of cases) {
      const issues = collectAppBundleIssues(appInput({ 'index.html': htmlShell, 'app.js': line }, permissions));
      assert.deepEqual(issues, [], `expected clean for ${line} with ${JSON.stringify(permissions)}`);
    }
  });

  it('does not flag fs.list with variable or template-literal paths', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        'const folder = "Documents";',
        "window.eternal.fs.list({ path: folder }).then(() => {});",
        "window.eternal.fs.list({ path: `/Documents/${folder}` }).then(() => {});",
      ].join('\n'),
    }, { fs: { read: ['/Photos/**'] } }));
    assert.deepEqual(issues, []);
  });

  it('flags fs.write paths outside the declared write globs', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': "window.eternal.fs.write({ path: '/Secret/new.md', content: 'x' });",
    }, { fs: { write: ['/Notes/**'] } }));
    assert.deepEqual(codesOf(issues), ['permission/fs-write-uncovered']);
    assert.match(issues[0].message, /rejected with 403/);
  });

  it('flags ipc topics outside the declared lists', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "window.eternal.ipc.emit('chat.message', { hi: true });",
        "window.eternal.ipc.on('chat.incoming', () => {});",
      ].join('\n'),
    }, { ipc: { emit: ['music.*'], listen: ['music.*'] } }));
    assert.deepEqual(codesOf(issues), ['permission/ipc-emit-uncovered', 'permission/ipc-listen-uncovered']);
  });

  it('flags undeclared fs/network/ipc usage on the code stream', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "window.eternal.fs.readText('/notes.txt');",
        "window.eternal.fetch('https://api.example.com/x');",
        "window.eternal.ipc.emit('topic', {});",
      ].join('\n'),
    }));
    assert.deepEqual(codesOf(issues), [
      'permission/undeclared-fs-read',
      'permission/undeclared-network',
      'permission/undeclared-ipc-emit',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Sandbox availability
// ---------------------------------------------------------------------------

describe('sandbox availability checks', () => {
  const htmlShell = HTML('<script src="app.js"></script>');

  it('flags opaque-origin storage access', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "localStorage.setItem('k', 'v');",
        "sessionStorage.setItem('k', 'v');",
        "document.cookie = 'k=v';",
        'void indexedDB;',
      ].join('\n'),
    }));
    assert.deepEqual(codesOf(issues), Array(4).fill('sandbox/blocked-storage'));
    assert.match(issues[0].message, /opaque origin/);
    assert.match(issues[0].hint, /window\.eternal\.storage/);
  });

  it('accepts storage feature detects (typeof / in-window)', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        'const hasLs = typeof localStorage !== "undefined";',
        'const hasSs = typeof window.sessionStorage !== "undefined";',
        "const hasIdb = typeof indexedDB !== 'undefined';",
        'const hasCookie = typeof (document.cookie) !== "undefined";',
        "const probe1 = 'localStorage' in window;",
        'const probe2 = "sessionStorage" in window;',
        "const probe3 = 'indexedDB' in globalThis;",
        'void hasLs; void hasSs; void hasIdb; void hasCookie; void probe1; void probe2; void probe3;',
      ].join('\n'),
    }));
    assert.deepEqual(issues, [], `expected feature detects to pass, got: ${JSON.stringify(issues)}`);
  });

  it('accepts storage access lexically inside a try block', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        'function load() {',
        '  try {',
        "    const raw = localStorage.getItem('k');",
        '    return JSON.parse(raw);',
        '  } catch {',
        '    return null;',
        '  }',
        '}',
        'try { void indexedDB; } finally {}',
        'function save(v) { try { document.cookie = "k=" + v; } catch (e) { void e; } }',
        'const guarded = () => { try { window.sessionStorage.setItem("k", "v"); } catch {} };',
        'void load; void save; void guarded;',
      ].join('\n'),
    }));
    assert.deepEqual(issues, [], `expected try-guarded access to pass, got: ${JSON.stringify(issues)}`);
  });

  it('still rejects unguarded storage, including inside catch blocks', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "localStorage.setItem('k', 'v');",
        'try { void 0; } catch { sessionStorage.setItem("k", "v"); }',
        'const store = window.localStorage;',
      ].join('\n'),
    }));
    // One issue per blocked API per file (deduped by design, so the repair
    // checklist stays tight): localStorage appears twice unguarded (call and
    // bare reference), sessionStorage once inside a catch block.
    assert.deepEqual(codesOf(issues), Array(2).fill('sandbox/blocked-storage'));
    const apis = issues.map((issue) => issue.message.split(' is not available')[0]).sort();
    assert.deepEqual(apis, ['localStorage', 'sessionStorage']);
  });

  it('rejects a bare if-guard but not the typeof probe beside it', () => {
    // `if (window.localStorage)` still throws — the property read itself is
    // the crash — so it stays an error; the typeof probe next to it passes.
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        'const known = typeof localStorage !== "undefined"; void known;',
        'if (window.localStorage) { void 1; }',
      ].join('\n'),
    }));
    assert.deepEqual(codesOf(issues), ['sandbox/blocked-storage']);
    assert.match(issues[0].message, /localStorage is not available/);
  });

  it('flags geolocation, getUserMedia, and worker construction', () => {
    const geolocation = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': 'navigator.geolocation.getCurrentPosition(() => {});',
    }));
    assert.deepEqual(codesOf(geolocation), ['sandbox/blocked-media']);

    const media = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': 'navigator.mediaDevices.getUserMedia({ video: true });',
    }));
    assert.deepEqual(codesOf(media), ['sandbox/blocked-media']);

    const workers = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': 'const w = new Worker("./worker.js");\nnavigator.serviceWorker.register("./sw.js");',
    }));
    assert.deepEqual(codesOf(workers), ['sandbox/blocked-worker', 'sandbox/blocked-worker']);
  });

  it('flags direct external network calls but not relative or bridge fetches', () => {
    const external = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "fetch('https://api.example.com/data').then(() => {});",
        "const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://api.example.com/x');",
        "const ws = new WebSocket('wss://api.example.com/socket');",
        "const es = new EventSource('https://api.example.com/stream');",
        "navigator.sendBeacon('https://api.example.com/beat');",
      ].join('\n'),
    }));
    assert.deepEqual(codesOf(external), Array(5).fill('sandbox/external-network'));

    const allowed = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "fetch('./data.json').then((r) => r.json());",
        "window.eternal.fetch('https://api.example.com/x').then(() => {});",
      ].join('\n'),
    }, { network: { outbound: ['api.example.com'] } }));
    assert.deepEqual(allowed, []);
  });
});

// ---------------------------------------------------------------------------
// Asset references + module graph
// ---------------------------------------------------------------------------

describe('asset and module checks', () => {
  it('flags missing HTML, CSS, and module references', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script src="does-not-exist.js"></script>'),
    }));
    assert.deepEqual(codesOf(issues), ['asset/missing']);

    const cssIssues = collectAppBundleIssues(appInput({
      'index.html': HTML('<link rel="stylesheet" href="./styles.css">'),
      'styles.css': "body { background: url('./missing.png'); }",
    }));
    assert.deepEqual(codesOf(cssIssues), ['asset/missing']);
    assert.match(cssIssues[0].message, /missing\.png/);

    const moduleIssues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script type="module" src="app.js"></script>'),
      'app.js': "import { helper } from './utils.js'; void helper;",
    }));
    assert.deepEqual(codesOf(moduleIssues), ['module/missing']);
  });

  it('treats query-suffixed and scheme-prefixed refs as valid or skipped', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<link rel="stylesheet" href="./styles.css?v=2"><img src="data:image/gif;base64,AAA"><a href="#top">top</a>'),
      'styles.css': '.hero { background: url("./banner.png#frag"); }',
      'banner.png': 'png',
    }));
    assert.deepEqual(issues, [], `expected refs to resolve, got: ${JSON.stringify(issues)}`);
  });

  it('flags named and default imports their target does not export', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script type="module" src="app.js"></script>'),
      'app.js': "import { init } from './boot.js';\nimport fallback from './boot.js';\nvoid init; void fallback;",
      'boot.js': 'export function start() {}\nexport const other = 1;\nexport { other as aliased };\n',
    }));
    assert.deepEqual(codesOf(issues), ['module/missing-export', 'module/missing-export']);
    assert.match(issues[0].message, /does not export "init"/);
    assert.match(issues[1].message, /no default export/);
  });

  it('accepts wildcard re-exports and resolvable aliased imports', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script type="module" src="app.js"></script>'),
      'app.js': [
        "import { start } from './boot.js';",
        "import { start as begin } from './boot.js';",
        "import { deep } from './star.js';",
        'void start; void begin; void deep;',
      ].join('\n'),
      // Re-export list: `start` is exported via the list, so both the plain
      // and the aliased import resolve.
      'boot.js': 'export { start } from "./lib/deep.js";\n',
      'lib/deep.js': 'export function deep() {}\nexport function start() {}\n',
      // Wildcard re-export surface: unknown surface — the validator stays
      // silent rather than guess.
      'star.js': "export * from './lib/deep.js';\n",
    }));
    assert.deepEqual(issues, [], `expected re-exports to resolve, got: ${JSON.stringify(issues)}`);
  });

  it('flags bare module specifiers (no package manager in the sandbox)', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script type="module" src="app.js"></script>'),
      'app.js': "import lodash from 'lodash'; void lodash;",
    }));
    assert.deepEqual(codesOf(issues), ['module/missing']);
    assert.match(issues[0].message, /bare specifier/);
  });
});

// ---------------------------------------------------------------------------
// Scanner precision (false-positive guards)
// ---------------------------------------------------------------------------

describe('source scanning precision', () => {
  const htmlShell = HTML('<script src="app.js"></script>');

  it('ignores APIs mentioned in comments and strings', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        '// localStorage would throw in the sandbox, so we avoid it.',
        "const note = \"apps that use localStorage break here\"; void note;",
        "const docs = 'window.eternal.fs.save(...) is not a real API'; void docs;",
        "const url = 'https://api.example.com/x'; void url;",
      ].join('\n'),
    }));
    assert.deepEqual(issues, [], `expected prose-only mentions to pass, got: ${JSON.stringify(issues)}`);
  });

  it('keeps scanning past regex literals that contain slashes', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': htmlShell,
      'app.js': [
        "const re = /https:\\/\\/example\\.com\\//;",
        'void re;',
        "localStorage.setItem('k', 'v');",
      ].join('\n'),
    }));
    assert.deepEqual(codesOf(issues), ['sandbox/blocked-storage']);
  });

  it('ignores inline content of scripts that have a src attribute', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<script src="app.js">localStorage.setItem("k","v")</script>'),
      'app.js': 'console.log("hi");',
    }));
    assert.deepEqual(issues, [], 'browsers ignore inline content of src scripts; so should the scanner');
  });

  it('ignores usage inside HTML comments', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': HTML('<!-- localStorage.setItem("k","v") --><script src="app.js"></script>'),
      'app.js': 'console.log("hi");',
    }));
    assert.deepEqual(issues, []);
  });

  it('produces aligned code and mixed streams', () => {
    const scan = scanScript([
      'const a = "str with // slashes";',
      '// whole line comment',
      'const b = 1 / 2; // trailing',
      'const c = `tpl ${a} chunk`;',
      '/* block */ const d = /re[gex]\/x/;',
    ].join('\n'));
    assert.equal(scan.code.length, scan.mixed.length);
    // String contents blanked in code, intact in mixed.
    assert.ok(!scan.code.includes('str with // slashes'));
    assert.ok(scan.mixed.includes('str with // slashes'));
    // Comments blanked in both.
    assert.ok(!scan.mixed.includes('whole line comment'));
    assert.ok(!scan.mixed.includes('block'));
    // Identifiers survive in code.
    assert.ok(scan.code.includes('const b'));
    assert.ok(scan.code.includes('const c'));
    // Template expression code survives, literal chunk does not.
    assert.ok(scan.code.includes('a'));
    assert.ok(!scan.code.includes('tpl '));
  });
});

// ---------------------------------------------------------------------------
// Compiled bundle contract
// ---------------------------------------------------------------------------

describe('compiled bundle checks', () => {
  const files = {
    'index.html': HTML('<script src="app.js"></script>'),
    'app.js': 'console.log("hi");',
  };

  function compiledContent(includeAppJs = true) {
    const assets = {
      'index.html': '<!doctype html>',
      ...(includeAppJs ? { 'app.js': 'console.log("hi");' } : {}),
      'eternal-runtime.js': 'window.eternal = {};',
    };
    return [
      `const ASSETS = ${JSON.stringify(assets)};`,
      'export default { async fetch(request, env) { return new Response("ok"); } };',
    ].join('\n');
  }

  it('accepts a well-formed compiled bundle', () => {
    const issues = collectAppBundleIssues(appInput(files, undefined, {
      compiled: { mainModule: 'bundle.js', modules: { 'bundle.js': compiledContent() } },
    }));
    assert.deepEqual(issues, []);
  });

  it('flags a missing entry module', () => {
    const issues = collectAppBundleIssues(appInput(files, undefined, {
      compiled: { mainModule: 'bundle.js', modules: {} },
    }));
    assert.deepEqual(codesOf(issues), ['bundle/entrypoint-missing']);
  });

  it('flags an entry module without a default fetch export', () => {
    const issues = collectAppBundleIssues(appInput(files, undefined, {
      compiled: {
        mainModule: 'bundle.js',
        modules: { 'bundle.js': compiledContent().replace('export default', 'const handler =') },
      },
    }));
    assert.deepEqual(codesOf(issues), ['bundle/entrypoint-export-missing']);
    assert.match(issues[0].message, /default fetch handler/);
  });

  it('flags source files that were not packaged into the compiled bundle', () => {
    const issues = collectAppBundleIssues(appInput(files, undefined, {
      compiled: { mainModule: 'bundle.js', modules: { 'bundle.js': compiledContent(false) } },
    }));
    assert.deepEqual(codesOf(issues), ['bundle/asset-not-packaged']);
    assert.match(issues[0].message, /"app\.js" was not packaged/);
  });

  it('accepts module objects with a js property', () => {
    const issues = collectAppBundleIssues(appInput(files, undefined, {
      compiled: { mainModule: 'bundle.js', modules: { 'bundle.js': { js: compiledContent() } } },
    }));
    assert.deepEqual(issues, []);
  });
});

// ---------------------------------------------------------------------------
// Error shape, formatting, determinism
// ---------------------------------------------------------------------------

describe('structured error output', () => {
  it('uses the single issue message verbatim for one problem', () => {
    const error = new AppValidationError([{
      code: 'asset/missing',
      message: 'Missing local asset "x.png" referenced from index.html',
    }]);
    assert.equal(error.message, 'Missing local asset "x.png" referenced from index.html');
    assert.equal(error.issues.length, 1);
  });

  it('numbers every problem in a multi-issue message', () => {
    const error = new AppValidationError([
      { code: 'sandbox/blocked-storage', message: 'localStorage is not available' },
      { code: 'asset/missing', message: 'Missing local asset "x.png"' },
      { code: 'module/missing-export', message: 'no such export' },
    ]);
    assert.match(error.message, /failed with 3 problem\(s\)/);
    assert.match(error.message, /1\. localStorage is not available/);
    assert.match(error.message, /3\. no such export/);
  });

  it('formats issues for the repair prompt with codes, files, and fixes', () => {
    const block = formatAppValidationIssues([
      {
        code: 'permission/fs-read-uncovered',
        message: 'eternal.fs.list({ path: "/Documents" }) is not covered',
        file: 'app.js',
        evidence: "eternal.fs.list({ path: '/Documents' })",
        hint: 'Declare the folder you list.',
      },
      {
        code: 'sandbox/blocked-storage',
        message: 'localStorage is not available',
        file: 'app.js',
        hint: 'Use window.eternal.storage.',
      },
    ]);
    assert.match(block, /1\. \[permission\/fs-read-uncovered\] — app\.js/);
    assert.match(block, /at: eternal\.fs\.list/);
    assert.match(block, /fix: Declare the folder you list\./);
    assert.match(block, /2\. \[sandbox\/blocked-storage\]/);
  });

  it('is deterministic: the same input yields the same issues twice', () => {
    const fixture = loadFixture('photo-grid');
    const files = {
      ...fixture.files,
      'app.js': fixture.files['app.js'] + "\nwindow.eternal.fs.list({ path: '/Other' });\nlocalStorage.setItem('k', 'v');\n",
    };
    const input = appInput(files, { fs: { read: ['/Photos/**'] } });
    const first = collectAppBundleIssues(input);
    const second = collectAppBundleIssues(input);
    assert.deepEqual(first, second);
    assert.deepEqual(codesOf(first), ['permission/fs-read-uncovered', 'sandbox/blocked-storage']);
  });
});
