/**
 * Table-driven tests for the Ask Eternal intent router (src/agents/intent.ts).
 *
 * Each row pins the route for one realistic phrasing. Sections mirror the
 * router's documented policy; "changed from the old inline classifier" marks
 * phrasings whose classification was deliberately fixed when the regexes were
 * extracted (the old classifier lived inline in OrchestratorAgent.ts).
 *
 * This file runs under plain `node --test` (Node strips the .ts types on
 * import), so it needs no wrangler and runs in milliseconds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHAT_ROUTES, classifyRoute } from '../src/agents/intent.ts';

/**
 * @typedef {{ text: string, route: string, note?: string }} IntentCase
 */

/** @param {string} name @param {IntentCase[]} cases */
function section(name, cases) {
  describe(name, () => {
    for (const { text, route, note } of cases) {
      it(`routes ${JSON.stringify(text)} → ${route}${note ? ` (${note})` : ''}`, () => {
        assert.equal(classifyRoute(text), route);
      });
    }
  });
}

describe('intent routing (classifyRoute)', () => {
  section('build-app requests → app-build', [
    { text: 'build me an app', route: 'app-build' },
    { text: 'can you build me a todo app?', route: 'app-build' },
    { text: 'Build a Pomodoro timer app', route: 'app-build' },
    { text: 'make me a kanban board app', route: 'app-build' },
    { text: 'create an app that shows my photos', route: 'app-build' },
    { text: 'i want you to make a painting app', route: 'app-build' },
    { text: 'generate a calculator app plz', route: 'app-build' },
    { text: 'build an app', route: 'app-build' },
    { text: 'make an app for tracking my workouts', route: 'app-build' },
    { text: "let's build a game", route: 'app-build' },
    { text: 'code me up a whiteboard app', route: 'app-build' },
    { text: 'ship an app that does unit conversions', route: 'app-build' },
    { text: 'implement a sticky note widget please', route: 'app-build' },
    { text: 'make me a game where a cat jumps', route: 'app-build' },
    { text: 'build me a recipe app that reads my notes', route: 'app-build' },
    // want/need phrasings — changed from the old inline classifier (was chat).
    { text: 'I need a pomodoro app', route: 'app-build', note: 'changed from chat' },
    { text: "I'd like a notepad app", route: 'app-build', note: 'changed from chat' },
    { text: 'i want an app for my recipes', route: 'app-build', note: 'changed from chat' },
    { text: 'make some apps for me', route: 'app-build', note: 'changed from chat (plural nouns)' },
    { text: 'rebuild my gallery app from scratch', route: 'app-build', note: 'changed from chat (rebuild verb)' },
  ]);

  section('edit-app requests → app-build (same toolset as build)', [
    { text: 'edit my app', route: 'app-build' },
    { text: 'update my app', route: 'app-build' },
    { text: 'fix the bug in my gallery app', route: 'app-build' },
    { text: 'edit the todo app so it has due dates', route: 'app-build' },
    { text: 'update the timer app to 25 minutes', route: 'app-build' },
    { text: 'make the background of my app blue', route: 'app-build' },
    { text: 'delete my test app', route: 'app-build' },
    { text: 'remove the app I made last week', route: 'app-build' },
    // The task's canonical edit phrasing — the old classifier missed "change"
    // entirely and routed these to chat.
    { text: 'change the color of my todo app', route: 'app-build', note: 'changed from chat' },
    { text: "change my app's theme to dark", route: 'app-build', note: 'changed from chat' },
    { text: 'add dark mode to my todo app', route: 'app-build', note: 'changed from chat' },
    { text: 'can you tweak the layout of the paint app?', route: 'app-build', note: 'changed from chat' },
    { text: 'improve my calculator app', route: 'app-build', note: 'changed from chat' },
    { text: 'rename my pomodoro app', route: 'app-build', note: 'changed from chat' },
    { text: 'recolor the whiteboard app please', route: 'app-build', note: 'changed from chat' },
    // noun-before-verb and cross-clause noun/verb splits.
    { text: 'my app is broken, can you fix it?', route: 'app-build', note: 'changed from chat' },
    { text: "my app's title is wrong, change it", route: 'app-build', note: 'changed from chat' },
    { text: 'uninstall the timer app', route: 'app-build', note: 'changed from chat (uninstall verb)' },
  ]);

  section('install-preview → app-install-preview', [
    { text: 'install the preview', route: 'app-install-preview' },
    { text: 'yes, install that preview please', route: 'app-install-preview' },
    { text: 'install app preview 3', route: 'app-install-preview' },
    { text: 'that preview looks great, install it', route: 'app-install-preview' },
    // Without the word "preview" there is nothing to install — the router
    // cannot see the previous turn, so these land in chat (unchanged).
    { text: 'looks good, install it', route: 'chat', note: 'anaphora: needs "preview"' },
    { text: 'install it', route: 'chat', note: 'anaphora: needs "preview"' },
  ]);

  section('app-read → inspect apps and source', [
    { text: 'what apps do I have?', route: 'app-read' },
    { text: 'show me my apps', route: 'app-read' },
    { text: 'list my apps', route: 'app-read' },
    { text: 'which apps are installed?', route: 'app-read' },
    { text: 'what does my todo app look like?', route: 'app-read' },
    { text: 'open the app source', route: 'app-read' },
    { text: 'let me see the source of the timer app', route: 'app-read' },
    { text: 'what is an app?', route: 'app-read', note: 'definitional; read-only route is harmless' },
    { text: 'what game should I make for the kids?', route: 'app-read', note: 'advice question, not a command' },
    // "source code" used to trip the "code" BUILD verb.
    { text: 'show me the source code of my gallery app', route: 'app-read', note: 'changed from app-build' },
    { text: 'review the source code of the app', route: 'app-read', note: 'changed from app-build' },
    // Expanded read words — changed from chat.
    { text: 'where is my calculator app?', route: 'app-read', note: 'changed from chat' },
    { text: 'do i have any apps?', route: 'app-read', note: 'changed from chat' },
    { text: 'my calculator app won\'t open, help!', route: 'app-read', note: 'changed from chat (read-only tools)' },
  ]);

  section('desktop-read → desktop content', [
    { text: "what's on my desktop?", route: 'desktop-read' },
    { text: "what's on my desktop", route: 'desktop-read' },
    { text: 'show me my photos', route: 'desktop-read' },
    { text: 'find my boarding pass pdf', route: 'desktop-read' },
    { text: 'find my todo app', route: 'desktop-read' },
    { text: 'search my files for taxes', route: 'desktop-read' },
    { text: 'do I have any audio files?', route: 'desktop-read' },
    { text: 'how many photos do I have?', route: 'desktop-read' },
    // Generic platform questions: kept on non-mutating routes (unchanged).
    { text: 'how does an app access my photos?', route: 'desktop-read', note: 'platform question, read-only route' },
    { text: 'peux-tu créer une app de notes?', route: 'desktop-read', note: 'mixed-language: "notes" is also an English desktop word — documented limitation' },
  ]);

  section('desktop-write → organize and create', [
    { text: 'organize my desktop', route: 'desktop-write' },
    { text: 'tidy up my desktop', route: 'desktop-write' },
    { text: 'move my photos into a folder', route: 'desktop-write' },
    { text: 'save a note saying buy milk', route: 'desktop-write' },
    { text: 'write a note to call mom', route: 'desktop-write' },
    { text: 'sort my apps', route: 'desktop-write', note: 'organizing, not building' },
    { text: 'group my games', route: 'desktop-write', note: 'organizing, not building' },
    // Folder creation used to require the noun BEFORE the verb.
    { text: 'create a folder called Work', route: 'desktop-write', note: 'changed from desktop-read' },
    { text: 'make a new folder for invoices', route: 'desktop-write', note: 'changed from desktop-read' },
    // Folder NAMES that sound like apps stay folder requests.
    { text: 'create a folder called Games', route: 'desktop-write', note: 'changed from desktop-read' },
    { text: 'add a note about the meeting tomorrow', route: 'desktop-write', note: 'changed from desktop-read' },
    // Negation guard covers app command verbs only — organization commands
    // keep their old behavior (the model will not call tools it was told not
    // to call; this pins the documented boundary).
    { text: "don't organize my desktop", route: 'desktop-write', note: 'unchanged; negation guard is app-scoped' },
    { text: 'stop organizing my desktop', route: 'desktop-read', note: 'unchanged; "organizing" is not a listed verb' },
  ]);

  section('plain chat', [
    { text: 'hi', route: 'chat' },
    { text: 'hello there', route: 'chat' },
    { text: 'hey!', route: 'chat' },
    { text: 'hi how are you', route: 'chat' },
    { text: 'happy birthday!', route: 'chat' },
    { text: 'what is the meaning of life?', route: 'chat' },
    { text: 'how do I change my wallpaper?', route: 'chat', note: 'appearance question, not a desktop noun' },
    { text: 'change my wallpaper', route: 'chat', note: 'no app noun → soft verbs cannot fire' },
    { text: 'explain quantum computing simply', route: 'chat' },
    { text: 'thanks for your help', route: 'chat' },
    { text: 'can you help me?', route: 'chat' },
    { text: 'i like turtles', route: 'chat' },
    { text: 'yes', route: 'chat' },
    { text: 'ok', route: 'chat' },
    { text: 'build', route: 'chat', note: 'a verb with no noun is not a request' },
    { text: 'update', route: 'chat', note: 'a verb with no noun is not a request' },
  ]);

  section('mentions of "app" in casual chat stay chat', [
    { text: 'I love this app!', route: 'chat' },
    { text: 'this is the best app ever', route: 'chat' },
    { text: 'my friend wants an app like this', route: 'chat', note: '"wants" is not the base form "want"' },
    { text: 'are you an app?', route: 'chat' },
    { text: 'is there an app for that?', route: 'chat' },
    { text: 'I use a different todo app on my phone', route: 'chat' },
    { text: "that app you made was cool but let's just talk", route: 'chat' },
    { text: 'I made you an app last week, thanks!', route: 'chat', note: 'past tense describes, it does not command' },
    { text: 'I used to build games in college', route: 'chat', note: 'past-tense chat (plural genre nouns stay conservative)' },
    { text: "I'm building a game in Unity, any tips?", route: 'chat', note: 'progressive form is not a command' },
    { text: 'Never gonna give you up, never gonna let you down', route: 'chat' },
    { text: 'I need an apple pie recipe', route: 'chat', note: '"apple"/"appointment" are not "app"' },
    { text: 'I have an appointment at 3', route: 'chat', note: '"appointment" is not "app"' },
    { text: 'help me get organized', route: 'chat', note: '"organized" is not the verb "organize"' },
    // changed: the old read-word regex was missing parentheses, so "shower"
    // matched "show" and compliments with "great … app" became app-read.
    { text: 'I had an app idea in the shower', route: 'chat', note: 'changed from app-read ("shower" matched "show")' },
    { text: 'what a great app you made me, thanks', route: 'chat', note: 'changed from app-read (compliment)' },
    // Anaphora without a noun.
    { text: 'make it blue', route: 'chat', note: 'anaphora: no app noun to anchor' },
    { text: 'add a button to it', route: 'chat', note: 'anaphora: no app noun to anchor' },
  ]);

  section('questions about apps that are not build requests', [
    // Capability questions — changed from app-read.
    { text: 'what apps can you build?', route: 'chat', note: 'changed from app-read' },
    { text: 'what kind of apps can you make?', route: 'chat', note: 'changed from app-read' },
    { text: 'can you build apps?', route: 'chat', note: 'unchanged; plural generic is a capability question' },
    { text: 'how do you build apps?', route: 'chat', note: 'process question' },
    // Recommendation questions — changed from app-read.
    { text: "what's the best note-taking app?", route: 'chat', note: 'changed from app-read' },
    { text: 'do you know any good pomodoro apps?', route: 'chat', note: 'unchanged' },
    // Deliberation keeps app tools available when the user owns the app noun.
    { text: 'which app should I build first?', route: 'app-build', note: 'changed from app-read (strong noun any-order)' },
    // "Do I need an app?" is a question, not a request.
    { text: 'do i need an app for that?', route: 'chat', note: 'unchanged; question guard on want/need' },
    // Generic capability questions land on non-mutating routes.
    { text: 'can apps read my files?', route: 'app-read', note: 'changed from desktop-read' },
  ]);

  section('negated commands', [
    { text: "don't build anything", route: 'chat', note: 'unchanged' },
    { text: "don't build an app yet", route: 'chat', note: 'changed from app-build' },
    { text: 'never make an app without asking', route: 'chat', note: 'changed from app-build' },
    { text: "I don't want you to create an app", route: 'chat', note: 'changed from app-build' },
    { text: "don't create the app, just explain the plan", route: 'chat', note: 'changed from app-build' },
    { text: "don't install the preview yet", route: 'chat', note: 'changed from app-install-preview' },
    { text: "there's no need to make an app", route: 'chat', note: 'changed from app-build' },
    { text: 'stop building, i changed my mind', route: 'chat', note: 'unchanged' },
    // Negation is clause-scoped: a surviving positive clause still builds.
    { text: "don't build the timer app, build a calculator app", route: 'app-build', note: 'negation guard is clause-scoped' },
  ]);

  section('greeting-then-request (a greeting is not the whole message)', [
    // changed: the old greeting pattern swallowed everything after "hi! ".
    { text: 'hi! build me a chess app', route: 'app-build', note: 'changed from chat' },
    { text: 'sup? can you build an app for me?', route: 'app-build', note: 'changed from chat' },
    { text: 'hello! what\'s on my desktop today?', route: 'desktop-read', note: 'changed from chat' },
    // Comma greetings never matched the old pattern either — unchanged.
    { text: 'hey, can you make me a timer app please?', route: 'app-build', note: 'unchanged' },
    { text: 'good morning, please build a calculator app', route: 'app-build', note: 'unchanged' },
  ]);

  section('non-English-ish phrasings (documented: fall through to chat)', [
    // Pure foreign-language input has no English command verb → chat (unchanged).
    { text: 'construye una app de notas', route: 'chat', note: 'documented limitation' },
    { text: 'crea una aplicacion de recetas', route: 'chat', note: 'documented limitation' },
    // Spanglish keeps working because the English verb carries it (unchanged).
    { text: 'can you make me una app para mi fotos?', route: 'app-build', note: 'unchanged' },
  ]);

  section('typo tolerance (explicit, bounded)', [
    { text: 'buld me an app', route: 'app-build', note: 'changed from chat (misspelling map)' },
    { text: 'can u make me an ap pls', route: 'app-build', note: 'changed from chat ("an ap" clipping)' },
    { text: 'make me a todo appp', route: 'app-build', note: 'unchanged; repeated-letter collapse' },
  ]);

  it('treats empty and whitespace-only input as chat', () => {
    assert.equal(classifyRoute(''), 'chat');
    assert.equal(classifyRoute('   '), 'chat');
    assert.equal(classifyRoute('\t\n '), 'chat');
  });

  it('is deterministic: the same input always yields the same route', () => {
    const samples = [
      'build me an app',
      "don't build an app yet",
      'what apps do I have?',
      'change the color of my todo app',
      'hi! build me a chess app',
      'organize my desktop',
    ];
    for (const text of samples) {
      const first = classifyRoute(text);
      for (let i = 0; i < 3; i++) {
        assert.equal(classifyRoute(text), first);
      }
    }
  });

  it('exposes the full route set and only ever returns known routes', () => {
    const expected = [
      'chat',
      'desktop-read',
      'desktop-write',
      'app-read',
      'app-build',
      'app-install-preview',
    ];
    assert.deepEqual([...CHAT_ROUTES], expected);
    const probes = [
      'build me an app',
      'organize my desktop',
      'show me my photos',
      'list my apps',
      'install the preview',
      'hello there',
      'zzzz unrecognizable',
    ];
    for (const text of probes) {
      assert.ok(
        CHAT_ROUTES.includes(classifyRoute(text)),
        `classifyRoute(${JSON.stringify(text)}) returned an unknown route`,
      );
    }
  });
});
