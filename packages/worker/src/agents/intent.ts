/**
 * intent.ts — deterministic, single-message intent routing for Ask Eternal.
 *
 * The OrchestratorAgent (agents/OrchestratorAgent.ts) picks the system prompt
 * and the tool subset it exposes from the route returned here, so this module
 * decides what the agent is even *able* to do on each turn. It is a pure
 * function over one user message: no LLM calls, no I/O, no shared state — the
 * same input always yields the same route (which is what makes it testable).
 *
 * Routes (in the priority order they are checked):
 *  1. `app-install-preview` — install an already-generated preview
 *     ("install the preview", "looks great, install that preview").
 *  2. `app-build`            — create a NEW app ("build me a todo app",
 *                              "make a game", "I need a pomodoro app") OR
 *                              change an EXISTING one ("edit my app", "change
 *                              the color of my todo app", "fix it", "add dark
 *                              mode"). Both map to the same route because the
 *                              app-builder toolset (preview / install / build /
 *                              update / delete + read tools) serves both; the
 *                              split matters here only so neither class of
 *                              phrasing falls through to chat.
 *  3. `app-read`             — inspect the user's apps or app source ("what
 *                              apps do I have?", "show me the source code of
 *                              my gallery app").
 *  4. `desktop-write`        — organize/mutate the desktop ("organize my
 *                              desktop", "create a folder", "save a note").
 *  5. `desktop-read`         — questions about desktop content ("what's on my
 *                              desktop?", "find my boarding pass pdf").
 *  6. `chat`                 — everything else, including questions about apps
 *                              in general, negated commands, greetings, and
 *                              any phrasing the tables below don't recognize.
 *
 * Documented boundaries (deliberate, not accidents):
 *  - Single message. Context-dependent anaphora ("make it blue", "install it")
 *    has no app noun to anchor on and lands in `chat`; the chat model will ask
 *    or the user restates with a noun.
 *  - "Install it" only routes to `app-install-preview` when the word "preview"
 *    appears; we cannot see the previous turn.
 *  - Negation is clause-scoped: a clause whose app command verb is governed by
 *    a negator ("don't", "never", "stop", "no need", "not going to", "would
 *    rather not", "quit") contributes no command signal. "Don't build the
 *    timer app, build a calculator app" still routes to `app-build` because the
 *    second clause survives.
 *  - Questions about apps in general — capabilities ("what apps can you
 *    build?"), recommendations ("what's the best note-taking app?") — are
 *    chat, not app routes, unless the user also issues a command.
 *  - Only imperative/base verb forms count as commands ("build", "make",
 *    "change"). Past tense and progressives ("I built a game last summer",
 *    "I'm making a game in Unity") are casual chat — they describe, they don't
 *    request. Third-person "builds" would collide with the noun form and is
 *    likewise out.
 *  - Non-English messages don't match any command table and fall through to
 *    `chat` on purpose (the chat model is still useful; the tables stay small
 *    and auditable). Mixed-language phrasings that contain an English command
 *    verb or noun still route normally.
 *  - Typo tolerance is limited and explicit: repeated-letter collapsing
 *    ("appp" → "app"), a small misspelling map ("buld" → "build",
 *    "aplicacion" → "application"), and treating "an/the/my ap" as "app" only
 *    when a command verb is present ("my AP homework" stays chat).
 *
 * To tune the router, edit the vocabulary tables below; every pattern is built
 * from them. intent.test.mjs pins the behavior table-style — update it in the
 * same commit as any change here.
 */

export type ChatRoute =
  | 'chat'
  | 'desktop-read'
  | 'desktop-write'
  | 'app-read'
  | 'app-build'
  | 'app-install-preview';

export const CHAT_ROUTES: readonly ChatRoute[] = [
  'chat',
  'desktop-read',
  'desktop-write',
  'app-read',
  'app-build',
  'app-install-preview',
];

/* ------------------------------------------------------------------ *
 * Vocabulary tables — the single place to tune matching.
 * ------------------------------------------------------------------ */

/**
 * Verbs that unambiguously command creating, mutating, installing, or removing
 * apps. May pair with ANY app noun (strong or weak) as long as the verb or a
 * form of address suggests a request. Morphology: base forms only.
 */
const HARD_APP_VERBS =
  'build|create|make|generate|code|ship|implement|rebuild|install|uninstall|update|modify|edit|fix|delete|remove';

/**
 * Edit verbs whose signal is weaker ("add" and "change" collocate with too many
 * non-app things — "add a note", "change my wallpaper"). They only count when
 * an unambiguously app-shaped noun (app/application/widget) is also present,
 * in any order: "add dark mode to my todo app", "my app's theme, change it".
 */
const SOFT_APP_VERBS = 'change|add|save|put|log|mark|import|copy|tweak|improve|rename|redesign|restyle|recolor';

/**
 * Nouns that always refer to an EternalOS app. Soft edit verbs require one of
 * these; hard verbs accept them in any order ("my app is broken, fix it").
 */
const STRONG_APP_NOUNS = 'app|apps|application|applications|widget|widgets';

/**
 * Genre words that usually mean "an app" on EternalOS but can appear in casual
 * chat ("what game should I buy my nephew?"). Hard verbs pair with them only
 * in verb-before-noun order ("build a timer"), which keeps "what game should I
 * make?" an app-read question rather than a build command.
 */
const WEAK_APP_NOUNS =
  'game|timer|calculator|kanban|pomodoro|paint|canvas|editor|tracker|todo|todos|to-do|to do list|todo list|sticky note|sticky notes|whiteboard|notepad|notepads';

/** Question/inspection words that make a mention of apps an app-read intent. */
const APP_READ_WORDS =
  'what|which|show|list|inspect|review|open|read|see|view|check|tell|where|how many|do i have|did i|source';

/** Organize/tidy verbs for desktop writes. */
const DESKTOP_WRITE_VERBS = 'organize|organise|group|move|sort|tidy|clean up|file away';

/**
 * Desktop-content topic words. Deliberately does NOT include "wallpaper" or
 * appearance terms — "how do I change my wallpaper?" is a chat question.
 */
const TRASHABLE_NOUNS =
  'file|files|note|notes|memo|memos|folder|folders|image|images|photo|photos|picture|pictures|screenshot|screenshots|item|items|video|videos|duplicates|clutter|junk';

const APPEARANCE_NOUNS =
  'theme|themes|look|vibe|aesthetic|appearance|wallpaper|background|colou?rs?|colou?r scheme|palette|font|fonts|dark mode|light mode|style';

const DESKTOP_READ_WORDS =
  "desktop|file|files|folder|folders|image|images|photo|photos|picture|pictures|video|videos|audio|pdf|search|find|tag|tags|ocr|upload|uploads|overview|recent|note|notes|memo|memos";

/* ------------------------------------------------------------------ *
 * Compiled patterns.
 * ------------------------------------------------------------------ */

function wordRe(words: string): RegExp {
  return new RegExp(`\\b(?:${words})\\b`);
}

const GREETING_RE =
  /^(?:hi|hiya|hello|hey|yo|sup|howdy|greetings|good (?:morning|afternoon|evening))(?:[!.,? ]*(?:there|you|eternal|everyone|everybody|friend|friends|buddy|pal|folks|world|again))*[!.,? ]*$/;

const HARD_VERB_RE = wordRe(HARD_APP_VERBS);
const SOFT_VERB_RE = wordRe(SOFT_APP_VERBS);
const STRONG_NOUN_RE = wordRe(STRONG_APP_NOUNS);

/** Command verb before an app noun ("build me a todo app"); strongest form. */
const HARD_BEFORE_NOUN_RE = new RegExp(
  `\\b(?:${HARD_APP_VERBS})\\b.{0,80}\\b(?:${STRONG_APP_NOUNS}|${WEAK_APP_NOUNS})\\b`,
);

/**
 * App noun before a command verb — only for unambiguous nouns ("my app, fix
 * it"). The window is wide on purpose: bug reports put the details between
 * the two ("my Streak app shows a blank screen … console says … please fix
 * it" — seen live routing to chat, which cannot edit apps).
 */
const STRONG_BEFORE_HARD_RE = new RegExp(
  `\\b(?:${STRONG_APP_NOUNS})\\b.{0,300}\\b(?:${HARD_APP_VERBS})\\b`,
);

/** "Install … preview" in either order; "uninstall" deliberately does not match. */
const INSTALL_RE = /\binstall\w*\b/;
const PREVIEW_RE = /\bpreview\w*\b/;

/** "What apps can you build?" — a question about us, not an order. */
const CAPABILITY_QUESTION_RE =
  /\b(?:what|which)\b.{0,60}\b(?:can|could) you\b|\bhow (?:do|does|did|can|could) you\b|\b(?:can|could) you\b.{0,30}\b(?:build|make|create|generate|code|ship)\b.{0,30}\b(?:apps|applications|widgets|games)\b/;

/** "What's the best note-taking app?" — a recommendation question, not a build order. */
const RECOMMENDATION_QUESTION_RE =
  /\b(?:best|good|great|cool|nice|popular|recommended|recommend|favorite|favourite)\b.{0,40}\b(?:app|apps|application|applications|widget|widgets|game|games)\b/;

/** Folder creation in either order; checked before app routes so "create a folder called Games" is a desktop write. */
const FOLDER_CREATE_RE =
  /\b(?:create|make|add)\b.{0,60}\b(?:folder|folders)\b|\b(?:folder|folders)\b.{0,60}\b(?:create|make|new)\b/;

/** Read/inspect words paired with an app noun, in either order. */
const APP_READ_RE = new RegExp(
  `\\b(?:${APP_READ_WORDS})\\b.{0,80}\\b(?:${STRONG_APP_NOUNS}|${WEAK_APP_NOUNS})\\b`,
);
const APP_NOUN_READ_RE = new RegExp(
  `\\b(?:${STRONG_APP_NOUNS}|${WEAK_APP_NOUNS})\\b.{0,80}\\b(?:${APP_READ_WORDS})\\b`,
);
const APP_SOURCE_RE =
  /\b(?:app|application)s? source\b|\bsourcecode\b.{0,80}\b(?:app|application)s?\b/;

/** Desktop writes: organize/tidy verbs, folder creation, or note writing. */
const DESKTOP_WRITE_RE = new RegExp(
  `\\b(?:${DESKTOP_WRITE_VERBS})\\b` +
    `|\\b(?:create|make|add)\\b.{0,60}\\b(?:folder|folders)\\b` +
    `|\\b(?:folder|folders)\\b.{0,60}\\b(?:create|make|new)\\b` +
    `|\\b(?:write|save|jot|draft|create|make|add|take)\\b.{0,60}\\b(?:note|notes|memo|text file)\\b` +
    // Editing what is there: rename, rewrite a note, put things in the Trash.
    `|\\brename\\b` +
    `|\\b(?:edit|rewrite|update|append to|add to|fix)\\b.{0,40}\\b(?:note|notes|memo|text file)\\b` +
    `|\\b(?:delete|trash|remove|throw away|throw out|get rid of|bin)\\b.{0,60}\\b(?:${TRASHABLE_NOUNS})\\b`,
);

/**
 * Changing the desktop's look ("make my desktop feel like a rainy café",
 * "switch to a dark theme", "change my wallpaper to dots"). How-to questions
 * ("how do I change my wallpaper?") stay chat — see isAppearanceRequest.
 */
const APPEARANCE_WRITE_RE = new RegExp(
  `\\b(?:make|change|set|switch|turn|give|restyle|redesign|redo|paint|recolou?r|theme|style|update|use|apply)\\b.{0,60}\\b(?:${APPEARANCE_NOUNS})\\b` +
    `|\\b(?:${APPEARANCE_NOUNS})\\b.{0,40}\\b(?:to|into|like|more)\\b` +
    `|\\bmake\\b.{0,30}\\b(?:desktop|it|everything)\\b.{0,20}\\b(?:look|feel)\\b`,
);
/** App skins: "reskin my player", "give my app a skin", or a look change that names an app. */
const SKIN_RE = /\b(?:skin|skins|skinned|reskin|re-skin|eskin)\b/;
const HOW_TO_QUESTION_RE = /\bhow (?:do|can|could|would|should) (?:i|you|we)\b|\bwhere (?:do|can) i\b|\bis (?:it|there) (?:possible|a way)\b/;

export function isAppearanceRequest(text: string): boolean {
  return APPEARANCE_WRITE_RE.test(text) && !HOW_TO_QUESTION_RE.test(text);
}

const DESKTOP_READ_RE = wordRe(DESKTOP_READ_WORDS);

/** Want/need-style build requests: "I need a pomodoro app", "I'd like a notepad app". */
const WANT_APP_RE =
  /\b(?:want|need|wanna|looking for|could use|would like|would love|'d like|'d love)\b([^,.;]{0,25})\b(?:app|apps|application|applications|widget|widgets)\b/;

/** "do I need an app for that?" — a question, not a request. */
const DO_I_QUESTION_RE = /\b(?:do|should|must) i\b.{0,10}\b(?:need|want|get|have)\b/;

/** A clause whose command verb is governed by a negator contributes no signal. */
const NEGATED_CLAUSE_RE = new RegExp(
  `\\b(?:do not|don'?t|dont|never|stop|no need|not going to|would rather not|quit)\\b.{0,40}\\b(?:${HARD_APP_VERBS}|${SOFT_APP_VERBS})\\b`,
);

/** Misspellings of router keywords seen in real input. */
const TYPO_FIXES: Record<string, string> = {
  buld: 'build',
  bild: 'build',
  bulld: 'build',
  bulid: 'build',
  buidl: 'build',
  biuld: 'build',
  creat: 'create',
  aplication: 'application',
  aplicacion: 'application',
};

const ANY_COMMAND_VERB_RE = new RegExp(`\\b(?:${HARD_APP_VERBS}|${SOFT_APP_VERBS})\\b`);

/* ------------------------------------------------------------------ *
 * Normalization.
 * ------------------------------------------------------------------ */

const WEB_ADDRESS_RE = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\/[^\s<>"'`]*/gi;

function normalizeText(raw: string): string {
  // A web address is just "link" to the router: words inside it
  // ("example.com/build-a-todo-app") are not the user's request.
  let text = raw.replace(WEB_ADDRESS_RE, ' link ').trim().toLowerCase();
  // Strip diacritics so "aplicación" hits the misspelling map ("créer" → "creer"
  // is harmless — foreign verbs never match anyway).
  text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Typographic apostrophes/quotes → ASCII so "don’t" == "don't".
  text = text.replace(/[\u2018\u2019\u02BC`´]/g, "'").replace(/[\u201C\u201D]/g, '"');
  // Collapse 3+ repeated characters: "appp" → "app", "!!!!" → "!!".
  text = text.replace(/(.)\1{2,}/g, '$1$1');
  // Known misspellings of the keywords the router keys on.
  text = text.replace(/\b[\w'-]+\b/g, (word) => TYPO_FIXES[word] ?? word);
  // Fold "source code" into one token so the "code" BUILD verb does not fire
  // on read requests ("show me the source code of my gallery app").
  text = text.replace(/\bsource code\b/g, 'sourcecode');
  // "ap" as a clipping of "app" is only trusted next to an article/possessive
  // AND only when a command verb is present, so "my AP homework" stays chat.
  if (ANY_COMMAND_VERB_RE.test(text)) {
    text = text.replace(/\b((?:an?|the|my|this|that|new|his|her|our|their)\s+)ap\b/g, '$1app');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Drop clauses whose command is negated: "don't build the app, explain it instead". */
function stripNegatedClauses(text: string): string {
  return text
    .split(/[;,.!?]+/)
    .filter((clause) => clause.trim().length > 0 && !NEGATED_CLAUSE_RE.test(clause))
    .join(' ');
}

/** Want/need phrasing that is a genuine app request (not a question or musing). */
function wantsNewApp(text: string): boolean {
  const match = WANT_APP_RE.exec(text);
  if (!match) return false;
  // "I want to know/see/talk about what apps…" — mention, not request.
  if (/\bto\b/.test(match[1])) return false;
  // Brainstorming an idea is chat.
  if (/\bideas?\b/.test(text)) return false;
  // "Do I need an app for that?" is a question.
  if (DO_I_QUESTION_RE.test(text)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * The router.
 * ------------------------------------------------------------------ */

/** Optional per-user context the router may use without any I/O of its own. */
export interface RouteContext {
  /**
   * Names of the user's installed apps. A mention of one counts as an app noun,
   * so "add milk to my Groceries" or "what's in my guestlog?" reach the app
   * routes even without the word "app".
   */
  appNames?: readonly string[];
  /**
   * Nouns for the data the user's apps hold, from their backend routes
   * (`/api/books` → "books", "book"; see `appDataTermsFromRoutes`). Treated
   * like app names, so "add Dune to my books" reaches the app routes even
   * though the app is called "Shelf".
   */
  appDataTerms?: readonly string[];
  /**
   * Route of the previous user turn in this thread. A follow-up that names
   * nothing ("now make it blue", "add another one", "yes, install it")
   * inherits it instead of falling to chat, which cannot touch apps or files.
   */
  previousRoute?: ChatRoute;
}

/**
 * Recurring / automation requests and questions about saved routines. They
 * need the routine tools, which live on every tool route; desktop-write is
 * the most general one when nothing more specific matched.
 */
const ROUTINE_NOUN_RE = /\b(?:routines?|automations?|automate|automatically|on a schedule)\b/;
const RECURRENCE_RE =
  /\b(?:every (?:morning|evening|night|day|hour|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+ (?:hours?|days?))|each (?:morning|evening|night|day|hour|week)|daily|hourly|nightly|weekly)\b/;
/** A request to do something ("every morning, move…"), not a description ("I run every morning"). */
const ROUTINE_COMMAND_RE = new RegExp(
  `\\b(?:${HARD_APP_VERBS}|${SOFT_APP_VERBS}|${DESKTOP_WRITE_VERBS}|save|write|summarize|summarise|remind|check|log|record|back up|archive|clear|empty|set up|schedule)\\b`,
);

function isRoutineRequest(text: string): boolean {
  return ROUTINE_NOUN_RE.test(text) || (RECURRENCE_RE.test(text) && ROUTINE_COMMAND_RE.test(text));
}

/** Back-references and continuations that mark a message as a follow-up. */
const FOLLOW_UP_RE =
  /\b(?:it|its|it's|that|this|those|these|them|they|there|another|ones?|the same|again|too|also|instead|as well|more)\b|^(?:now|then|and|also|next|ok|okay|yes|yeah|yep|sure|please|go ahead|do it|do that|great|perfect|nice|cool)\b/;

/** Bare acknowledgements: no action requested, even after an app turn. */
const ACK_ONLY_RE =
  /^(?:thanks|thank you|thx|ty|cool|nice|great|awesome|perfect|lovely|neat|got it|no|nope|no thanks|never mind|nevermind)(?:[ ,!.]+(?:thanks|thank you|so much|a lot|man|dude|mate|eternal))*[!. ]*$/;

/** Bare go-aheads answering the assistant's own question ("want me to install it?"). */
const AFFIRM_RE = /^(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|do that|please do|sounds good|ship it|install it)\b/;

const QUESTION_START_RE = /^(?:what|which|how|why|where|when|who|does|do|is|are|can|could|show|list|tell)\b/;

/**
 * Follow-up routing: only when the message would otherwise be plain chat,
 * the previous turn was not chat, and the message reads like a continuation.
 */
function followUpRoute(text: string, actionText: string, previous: ChatRoute | undefined): ChatRoute | null {
  if (!previous || previous === 'chat') return null;
  if (ACK_ONLY_RE.test(text)) return null;
  if (!FOLLOW_UP_RE.test(text) && !AFFIRM_RE.test(text)) return null;
  if (!actionText.trim()) return null; // every clause was a negated command
  const isQuestion = QUESTION_START_RE.test(text) || /\?\s*$/.test(text);
  const hasCommand = ANY_COMMAND_VERB_RE.test(actionText) || AFFIRM_RE.test(text)
    || /\b(?:make|turn|set|put|use|show|hide|move|rename|remove|delete|add|change|fix|install)\b/.test(actionText);

  if (previous.startsWith('app-')) {
    if (INSTALL_RE.test(actionText) && previous === 'app-install-preview') return 'app-install-preview';
    if (isQuestion && !hasCommand) return 'app-read';
    return 'app-build';
  }
  // desktop-read / desktop-write
  if (isQuestion && !hasCommand) return 'desktop-read';
  return DESKTOP_WRITE_RE.test(actionText) || hasCommand ? 'desktop-write' : previous;
}

/** Names that would hijack ordinary desktop/chat phrasing if treated as apps. */
const UNSAFE_APP_NAME_RE = new RegExp(
  `^(?:${DESKTOP_READ_WORDS}|${DESKTOP_WRITE_VERBS}|${HARD_APP_VERBS}|${SOFT_APP_VERBS}|my|me|it|this|that|the|new|eternal|wallpaper|theme|memory|memories)$`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Route path words too generic to identify an app's data. */
const GENERIC_ROUTE_WORDS = new Set([
  'api', 'data', 'state', 'status', 'health', 'healthz', 'ping', 'stats', 'stat', 'summary', 'config', 'settings',
  'setting', 'info', 'meta', 'reset', 'clear', 'search', 'export', 'import', 'sync', 'version', 'list', 'all', 'count',
  'items', 'item', 'entries', 'entry', 'records', 'record', 'today', 'latest', 'recent', 'toggle', 'done', 'complete',
  'new', 'bulk', 'batch', 'random', 'next', 'prev', 'current', 'debug', 'init', 'seed', 'me', 'auth', 'login', 'logout',
]);

function singularize(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us)$/.test(word)) return word;
  if (/(?:ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * Data nouns from an app's backend routes ("GET /api/books/:id" → "books",
 * "book"). Path params, generic words and anything that is not a plain word
 * are skipped; the router's own unsafe-name filter applies on top.
 */
export function appDataTermsFromRoutes(routes: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const route of routes) {
    const path = route.split(/\s+/).pop() ?? '';
    for (const raw of path.split('/').slice(2)) {
      const segment = raw.toLowerCase().replace(/[-_]+/g, ' ').trim();
      if (!/^[a-z]+(?: [a-z]+)?$/.test(segment)) continue;
      if (GENERIC_ROUTE_WORDS.has(segment)) continue;
      terms.add(segment);
      const singular = singularize(segment);
      if (!GENERIC_ROUTE_WORDS.has(singular)) terms.add(singular);
    }
  }
  return [...terms];
}

/** Replace mentions of the user's app names with the token "app". */
function substituteAppNames(text: string, appNames: readonly string[] | undefined): string {
  if (!appNames?.length) return text;
  const names = appNames
    .map((name) => normalizeText(name).replace(/\b(?:app|application)$/, '').trim())
    .filter((name) => name.length >= 3 && !UNSAFE_APP_NAME_RE.test(name))
    // Longest first so "habit tracker pro" wins over "habit tracker".
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const name of names) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), 'app');
  }
  return result;
}

export function classifyRoute(rawText: string, context: RouteContext = {}): ChatRoute {
  const text = substituteAppNames(normalizeText(rawText), [
    ...(context.appNames ?? []),
    ...(context.appDataTerms ?? []),
  ]);
  if (!text) return 'chat';
  // Pure greetings ask for nothing; a greeting followed by a command is NOT
  // a greeting ("hi! build me a chess app" must reach the app rules below).
  if (GREETING_RE.test(text)) return 'chat';

  // Negated command clauses contribute nothing to any app/write route.
  const actionText = stripNegatedClauses(text);

  // 1) Install an already-generated preview. Checked first because "install"
  //    is also a build verb ("install the app you just built").
  if (INSTALL_RE.test(actionText) && PREVIEW_RE.test(actionText)) {
    return 'app-install-preview';
  }

  // 2) Capability questions are chat even though they contain "build an app".
  if (CAPABILITY_QUESTION_RE.test(actionText)) {
    return 'chat';
  }

  const hardVerb = HARD_VERB_RE.test(actionText);
  const softVerb = SOFT_VERB_RE.test(actionText);
  const strongNoun = STRONG_NOUN_RE.test(actionText);

  // 3) Recommendation questions are chat unless a real command is also present
  //    ("build me the BEST todo app" still routes to app-build).
  if (
    !hardVerb &&
    !(softVerb && strongNoun) &&
    !wantsNewApp(actionText) &&
    RECOMMENDATION_QUESTION_RE.test(actionText)
  ) {
    return 'chat';
  }

  // 4) Folder creation is a desktop write even when the folder NAME sounds like
  //    an app ("create a folder called Games") — unless an actual app noun is
  //    present ("make a folder app" is an app).
  if (FOLDER_CREATE_RE.test(actionText) && !strongNoun) {
    return 'desktop-write';
  }

  // 4b) Skinning an app, or changing the look of something that is an app
  //     ("make my music app look like brushed metal", "give Tally a wood
  //     look" — app names are substituted with "app" above).
  if (
    (SKIN_RE.test(actionText) && !HOW_TO_QUESTION_RE.test(actionText) && !CAPABILITY_QUESTION_RE.test(actionText)) ||
    (strongNoun && isAppearanceRequest(actionText) && !/^\s*(?:what|which|where|why|who|how|does|do|is|are)\b/.test(actionText))
  ) {
    return 'app-build';
  }

  // 5) App create/edit commands, in decreasing strength:
  //    "build me a todo app" (verb → noun, any noun)
  //    "my app is broken, fix it" (strong noun → verb)
  //    "change the color of my todo app" (soft verb + strong noun, any order)
  //    "I need a pomodoro app" (want/need phrasing)
  if (
    HARD_BEFORE_NOUN_RE.test(actionText) ||
    STRONG_BEFORE_HARD_RE.test(actionText) ||
    (softVerb && strongNoun) ||
    wantsNewApp(actionText)
  ) {
    return 'app-build';
  }

  // 5b) Recurring work / saved routines.
  if (isRoutineRequest(actionText) && !CAPABILITY_QUESTION_RE.test(actionText)) {
    return 'desktop-write';
  }

  // 6) Inspecting existing apps or app source.
  if (
    APP_READ_RE.test(actionText) ||
    APP_NOUN_READ_RE.test(actionText) ||
    APP_SOURCE_RE.test(actionText)
  ) {
    return 'app-read';
  }

  // 7) Desktop writes (organize, folder creation, note writing, renaming,
  //    trashing, and changing the desktop's look).
  if (DESKTOP_WRITE_RE.test(actionText) || isAppearanceRequest(actionText)) {
    return 'desktop-write';
  }

  // 8) Desktop-content questions run on the full text (not the negation-
  //    stripped one) so "don't delete my photos" still looks at desktop
  //    context; the write tools are not exposed by this route either way.
  if (DESKTOP_READ_RE.test(text)) {
    return 'desktop-read';
  }

  return followUpRoute(text, actionText, context.previousRoute) ?? 'chat';
}
