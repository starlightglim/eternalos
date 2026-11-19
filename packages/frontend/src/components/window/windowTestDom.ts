// A minimal, self-contained DOM implementation — just enough of the HTML DOM
// for `react-dom/client` to mount the real Window component in a Node test
// environment, plus browser-faithful pointer/click semantics:
//
//  - events dispatch with capture and bubble phases through the fake tree,
//  - `preventDefault()` on a cancelable pointerdown/pointerup suppresses the
//    subsequent click (browsers suppress compatibility mouse events),
//  - `setPointerCapture()` retargets later pointer events for that pointer,
//    and the click is dispatched on the nearest common inclusive ancestor of
//    the press and release targets, as browsers compute it.
//
// Those two rules are what make the Window body-drag regression test honest:
// if Window ever goes back to hijacking the press (capturing the pointer or
// canceling pointerdown), the click on a plain child div no longer reaches it
// and the test fails.
//
// No dependency on jsdom/happy-dom: the repo has neither, and the test suite
// runs in a plain Node environment.

export class TestEvent {
  readonly type: string;
  target: TestNode | null = null;
  currentTarget: TestNode | null = null;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  propagationStopped = false;
  immediateStopped = false;
  eventPhase = 0;
  readonly timeStamp = Date.now();
  readonly isTrusted = true;
  srcElement: TestNode | null = null;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = init['bubbles'] !== false;
    this.cancelable = init['cancelable'] === true;
    for (const [key, value] of Object.entries(init)) {
      if (key !== 'bubbles' && key !== 'cancelable') {
        Object.defineProperty(this, key, { value, enumerable: true, writable: true });
      }
    }
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

interface EventListenerRecord {
  callback: (event: TestEvent) => void;
  capture: boolean;
}

class TestStyle {
  private readonly props = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
    (this as unknown as Record<string, string>)[name] = value;
  }

  removeProperty(name: string): string {
    const value = this.props.get(name) ?? '';
    this.props.delete(name);
    delete (this as unknown as Record<string, string>)[name];
    return value;
  }

  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

export class TestNode {
  nodeType = 0;
  nodeName = '';
  parentNode: TestNode | null = null;
  readonly childNodes: TestNode[] = [];
  readonly listeners = new Map<string, EventListenerRecord[]>();
  ownerDocument: TestDocument;

  constructor(ownerDocument: TestDocument) {
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): TestNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousSibling(): TestNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }

  get parentNodeChain(): TestNode[] {
    const chain: TestNode[] = [this];
    let ancestor = this.parentNode;
    while (ancestor) {
      chain.push(ancestor);
      ancestor = ancestor.parentNode;
    }
    return chain;
  }

  appendChild(child: TestNode): TestNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: TestNode, reference: TestNode | null): TestNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    if (reference && index === -1) throw new Error('insertBefore: reference node is not a child');
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: TestNode): TestNode {
    const index = this.childNodes.indexOf(child);
    if (index === -1) throw new Error('removeChild: node is not a child');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(newChild: TestNode, oldChild: TestNode): TestNode {
    const index = this.childNodes.indexOf(oldChild);
    if (index === -1) throw new Error('replaceChild: node is not a child');
    this.childNodes.splice(index, 1, newChild);
    oldChild.parentNode = null;
    newChild.parentNode = this;
    return oldChild;
  }

  contains(node: TestNode | null): boolean {
    for (let current: TestNode | null = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  get textContent(): string {
    let text = '';
    for (const child of this.childNodes) text += child.textContent;
    return text;
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value));
  }

  get nodeValue(): string {
    return this.textContent;
  }

  set nodeValue(value: string) {
    this.textContent = value;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  addEventListener(
    type: string,
    callback: (event: TestEvent) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    const records = this.listeners.get(type) ?? [];
    records.push({ callback, capture });
    this.listeners.set(type, records);
  }

  removeEventListener(
    type: string,
    callback: (event: TestEvent) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    const records = this.listeners.get(type);
    if (!records) return;
    const index = records.findIndex((record) => record.callback === callback && record.capture === capture);
    if (index !== -1) records.splice(index, 1);
  }
}

export class TestTextNode extends TestNode {
  nodeType = 3;
  nodeName = '#text';
  data: string;

  constructor(ownerDocument: TestDocument, data: string) {
    super(ownerDocument);
    this.data = data;
  }

  override get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = value;
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = value;
  }
}

export class TestElement extends TestNode {
  nodeType = 1;
  override nodeName: string; // uppercase tag name
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly style = new TestStyle();
  private readonly attributes = new Map<string, string>();
  // Default geometry large enough that Window's in-bounds pointer checks pass.
  rect = { left: 0, top: 0, width: 640, height: 480 };

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument);
    this.nodeName = tagName.toUpperCase();
  }

  get tagName(): string {
    return this.nodeName;
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.setAttribute('class', value);
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.setAttribute('id', value);
  }

  get classList(): Set<string> {
    return new Set(this.className.split(/\s+/).filter(Boolean));
  }

  get dataset(): Record<string, string | undefined> {
    const data: Record<string, string | undefined> = {};
    for (const [name, value] of this.attributes) {
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        data[key] = value;
      }
    }
    return data;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }

  get clientWidth(): number {
    return this.rect.width;
  }

  get clientHeight(): number {
    return this.rect.height;
  }

  // Pointer capture bookkeeping (shared state lives on the document).
  setPointerCapture(pointerId: number): void {
    this.ownerDocument.pointerCapture.set(pointerId, this);
  }

  releasePointerCapture(pointerId: number): void {
    if (this.ownerDocument.pointerCapture.get(pointerId) === this) {
      this.ownerDocument.pointerCapture.delete(pointerId);
    }
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.ownerDocument.pointerCapture.get(pointerId) === this;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

export class TestDocument extends TestNode {
  nodeType = 9;
  override nodeName = '#document';
  documentElement: TestElement;
  body: TestElement;
  head: TestElement;
  activeElement: TestElement | null = null;
  readonly pointerCapture = new Map<number, TestElement>();
  // Assigned by installTestDom() (the window object is created after the document).
  defaultView!: TestWindowGlobal;

  constructor() {
    // The super() call needs an ownerDocument reference that doesn't exist
    // yet; nodes created below are re-owned after the fact.
    super(undefined as unknown as TestDocument);
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.ownerDocument = this;
    this.documentElement.ownerDocument = this;
    this.head.ownerDocument = this;
    this.body.ownerDocument = this;
    this.activeElement = this.body;
  }

  createElement(tagName: string): TestElement {
    const element = new TestElement(this, tagName);
    return element;
  }

  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName);
  }

  createTextNode(data: string): TestTextNode {
    return new TestTextNode(this, data);
  }

  createComment(data: string): TestNode {
    const comment = new TestNode(this);
    comment.nodeType = 8;
    comment.nodeName = '#comment';
    comment.nodeValue = data;
    return comment;
  }

  getElementById(id: string): TestElement | null {
    const search = (node: TestNode): TestElement | null => {
      for (const child of node.childNodes) {
        if (child instanceof TestElement && child.getAttribute('id') === id) return child;
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this);
  }
}

interface TestWindowGlobal {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(_element: TestNode): { getPropertyValue(_name: string): string };
  addEventListener(_type: string, _callback: unknown, _options?: unknown): void;
  removeEventListener(_type: string, _callback: unknown, _options?: unknown): void;
  // Constructors React's commit path probes with `instanceof`.
  HTMLElement: unknown;
  Element: unknown;
  Node: unknown;
  HTMLIFrameElement: unknown;
}

export interface PointerInit {
  clientX?: number;
  clientY?: number;
  button?: number;
  buttons?: number;
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

export interface KeyInit {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

const DEFAULT_POINTER_ID = 1;

export interface TestDom {
  document: TestDocument;
  window: TestWindowGlobal;
  /** A container element appended to <body>, ready for createRoot(). */
  root: TestElement;
  /** Dispatch a pointer event (bubbles, cancelable) on `target`. */
  pointer(target: TestElement, type: 'pointerdown' | 'pointermove' | 'pointerup', init?: PointerInit): TestEvent;
  /**
   * Dispatch the click that a browser would produce for the most recent
   * pointerdown/pointerup pair: on the nearest common inclusive ancestor of
   * the press and release targets, unless the press or release was canceled
   * (browsers then suppress the click) — and honoring pointer capture, which
   * retargets the release. Returns null when the click was suppressed.
   */
  click(init?: PointerInit): TestEvent | null;
  /** The element currently holding pointer capture for `pointerId`, if any. */
  captureHolder(pointerId?: number): TestElement | undefined;
  /** Dispatch a keyboard event (bubbles, cancelable) on `target`. */
  key(target: TestElement, type: 'keydown' | 'keyup', init?: KeyInit): TestEvent;
  /** First descendant (depth-first) with `name` set to exactly `value`. */
  findDescendant(from: TestElement, name: string, value: string): TestElement | undefined;
  /** Remove the globals this instance installed. */
  uninstall(): void;
}

function commonInclusiveAncestor(a: TestNode, b: TestNode): TestNode {
  const ancestors = new Set(a.parentNodeChain);
  for (let node: TestNode | null = b; node; node = node.parentNode) {
    if (ancestors.has(node)) return node;
  }
  throw new Error('commonInclusiveAncestor: nodes are not in one tree');
}

function dispatchEvent(target: TestNode, type: string, init: Record<string, unknown>): TestEvent {
  const event = new TestEvent(type, init);
  event.target = target;
  event.srcElement = target;
  const path = target.parentNodeChain; // [target, ..., document]
  const callListeners = (node: TestNode, capture: boolean): void => {
    event.currentTarget = node;
    for (const record of node.listeners.get(type) ?? []) {
      if (record.capture !== capture) continue;
      record.callback(event);
      if (event.immediateStopped) return;
    }
  };
  event.eventPhase = 1; // capture
  for (let i = path.length - 1; i > 0; i -= 1) {
    callListeners(path[i], true);
    if (event.propagationStopped) break;
  }
  if (!event.propagationStopped) {
    event.eventPhase = 2; // at target
    callListeners(target, true);
    callListeners(target, false);
  }
  if (event.bubbles && !event.propagationStopped) {
    event.eventPhase = 3; // bubble
    for (let i = 1; i < path.length; i += 1) {
      callListeners(path[i], false);
      if (event.propagationStopped) break;
    }
  }
  event.eventPhase = 0;
  event.currentTarget = null;
  return event;
}

export function installTestDom(): TestDom {
  const document = new TestDocument();
  const window: TestWindowGlobal = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // React's commit path (`getActiveElementDeep` and friends) runs
    // `instanceof` against these constructors.
    HTMLElement: TestElement,
    Element: TestElement,
    Node: TestNode,
    HTMLIFrameElement: class HTMLIFrameElement extends TestElement {},
  };
  document.defaultView = window;

  const storage = new Map<string, string>();
  const localStorageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };

  const root = document.createElement('div');
  document.body.appendChild(root);

  let pressedAt: TestElement | null = null;
  let releasedAt: TestElement | null = null;
  let clickSuppressed = false;

  const pointer = (target: TestElement, type: 'pointerdown' | 'pointermove' | 'pointerup', init: PointerInit = {}): TestEvent => {
    const pointerId = init.pointerId ?? DEFAULT_POINTER_ID;
    // A capture set during a previous event retargets subsequent pointer
    // events for that pointer, as in browsers.
    const effectiveTarget = type === 'pointerdown'
      ? target
      : (document.pointerCapture.get(pointerId) ?? target);
    const base: Record<string, unknown> = {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: init.pointerType ?? 'mouse',
      isPrimary: init.isPrimary ?? true,
      button: init.button ?? 0,
      buttons: init.buttons ?? (type === 'pointerup' ? 0 : 1),
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      screenX: init.clientX ?? 0,
      screenY: init.clientY ?? 0,
      detail: 1,
      view: window,
      relatedTarget: null,
    };
    const event = dispatchEvent(effectiveTarget, type, base);
    if (type === 'pointerdown') {
      pressedAt = effectiveTarget;
      releasedAt = null;
      clickSuppressed = event.defaultPrevented;
    } else if (type === 'pointerup') {
      releasedAt = effectiveTarget;
      if (event.defaultPrevented) clickSuppressed = true;
      // Pointer capture is implicitly released when the pointer goes up.
      document.pointerCapture.delete(pointerId);
    }
    return event;
  };

  const dom: TestDom = {
    document,
    window,
    root,
    pointer,
    click: (init: PointerInit = {}): TestEvent | null => {
      if (!pressedAt) throw new Error('click() called without a preceding pointerdown');
      if (clickSuppressed) {
        pressedAt = null;
        releasedAt = null;
        clickSuppressed = false;
        return null;
      }
      const target = releasedAt ? commonInclusiveAncestor(pressedAt, releasedAt) : pressedAt;
      const event = dispatchEvent(target, 'click', {
        bubbles: true,
        cancelable: true,
        detail: 1,
        clientX: init.clientX ?? 0,
        clientY: init.clientY ?? 0,
        screenX: init.clientX ?? 0,
        screenY: init.clientY ?? 0,
        view: window,
        relatedTarget: null,
      });
      pressedAt = null;
      releasedAt = null;
      clickSuppressed = false;
      return event;
    },
    captureHolder: (pointerId: number = DEFAULT_POINTER_ID) => document.pointerCapture.get(pointerId),
    key: (target: TestElement, type: 'keydown' | 'keyup', init: KeyInit = {}): TestEvent => {
      const event = dispatchEvent(target, type, {
        bubbles: true,
        cancelable: true,
        key: init.key ?? '',
        code: init.code ?? '',
        ctrlKey: init.ctrlKey ?? false,
        shiftKey: init.shiftKey ?? false,
        altKey: init.altKey ?? false,
        metaKey: init.metaKey ?? false,
        repeat: init.repeat ?? false,
        detail: 0,
        view: window,
      });
      return event;
    },
    findDescendant: (from: TestElement, name: string, value: string) => {
      const visit = (node: TestNode): TestElement | undefined => {
        for (const child of node.childNodes) {
          if (child instanceof TestElement) {
            if (child.getAttribute(name) === value) return child;
            const found = visit(child);
            if (found) return found;
          }
        }
        return undefined;
      };
      return visit(from);
    },
    uninstall: () => {
      Reflect.deleteProperty(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'window');
      Reflect.deleteProperty(globalThis, 'localStorage');
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    },
  };

  Object.assign(globalThis, {
    document,
    window,
    localStorage: localStorageShim,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  return dom;
}
