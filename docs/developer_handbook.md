# EternalOS Sandbox App Developer Handbook

Welcome to the EternalOS Sandbox App Developer Handbook! This guide provides a comprehensive manual procedure and technical reference for creating, developing, and deploying fully sandboxed, highly-capable applications on EternalOS.

By combining the local-first CLI tool (`eternal-app.mjs`) with the power of AI coding assistants, you can build premium sandboxed apps that feel like first-class desktop citizens—complete with filesystem access, key-value storage, real-time inter-app communication (IPC), custom window controls, secure networking, and custom file double-click handlers.

---

## 1. Architectural Overview

EternalOS apps are fully sandboxed for maximum security while maintaining deep OS integration:
1. **Dynamic Worker Isolates**: Apps are deployed as Cloudflare Dynamic Worker instances. The backend bundles your static assets (HTML, JS, CSS) into a worker module.
2. **Iframe Sandboxing**: On the frontend, apps run within an iframe using `sandbox="allow-scripts"` to prevent access to the main browser context, cookies, or outer DOM.
3. **The `window.eternal` Bridge**: At load time, a secure, immutable runtime bridge is injected into the app. All communications with the OS (filesystem, storage, network proxy, window controls, IPC) go through this signed bridge.
4. **Stateless Capability Tokens**: Permission validations are checked on each loopback request via signed JWT capability payloads, keeping performance ultra-fast.

---

## 2. Fast-Track Developer Workflow

Follow this manual procedure to develop apps locally using your favorite IDE and deploy them straight to your EternalOS desktop.

### Step 1: Authenticate and Configure the CLI
To deploy applications, the developer CLI tool must be authorized with your user session.
1. Log in to your EternalOS instance in the browser.
2. Open Chrome DevTools (`F12` or `Cmd+Option+I`), navigate to the **Application** or **Storage** tab, and copy your authenticated JWT Bearer token from local storage (look for `eternal-session-token` or extract it from the authorization headers in the Network tab).
3. In your local terminal, run the configuration command to save the token locally:
   ```bash
   node scripts/eternal-app.mjs config <your-jwt-token>
   ```
   *This saves your credentials securely in `.eternal-config.json` inside the repository root.*

### Step 2: Scaffold a New Project
Create a new local application directory with standard files and a default manifest:
```bash
node scripts/eternal-app.mjs init my-custom-app
```
This generates the following files under `my-custom-app/`:
- `eternal.app.json` — The application manifest (permissions, metadata, window sizes).
- `index.html` — The main HTML interface.
- `app.js` — The logic entrypoint where you call `window.eternal` APIs.

### Step 3: Local-First Development
Open the generated directory in your code editor. Write vanilla HTML, CSS, and Javascript. Use standard web APIs and leverage the rich list of custom `window.eternal` bridge features (detailed in Section 3 below).

### Step 4: Deploy and Verify
To compile, bundle, and push your application files straight onto your EternalOS desktop, run:
```bash
node scripts/eternal-app.mjs deploy my-custom-app
```
- **New Deployments**: Automatically registers the app, compiles it into a Dynamic Worker, and places a new launch icon on your desktop.
- **Subsequent Updates**: Keeps the same icon and settings while instantly upgrading the running code in the Cloudflare isolate and increasing the app version.

---

## 3. The `window.eternal` API Reference

All capabilities are exposed via the global, read-only, and frozen `window.eternal` object.

### 3.1 Metadata & Profile
* **`eternal.appId`** *(string)*: The unique UUID identifying this application instance.
* **`eternal.hostVersion`** *(string)*: The current API version of the host OS bridge.
* **`eternal.profile.get()`**: Fetches details about the currently logged-in user.
  - **Returns**: `Promise<{ username: string, displayName?: string }>`

### 3.2 Desktop Filesystem (`eternal.fs`)
Gated by policies declared under `permissions.fs` in the app's manifest. Paths use a Unix-like format starting at `/` (representing the desktop root).

* **`fs.list(opts)`**: Lists files and folders matching target criteria.
  - **Arguments**: `opts?: { path?: string, mimeType?: string, limit?: number }`
  - **Returns**: `Promise<DesktopItem[]>`
* **`fs.read(itemId)`**: Reads a desktop file as a binary Blob.
  - **Arguments**: `itemId: string`
  - **Returns**: `Promise<Blob>`
* **`fs.readText(itemId)`**: Reads a desktop file directly as a string.
  - **Arguments**: `itemId: string`
  - **Returns**: `Promise<string>`
* **`fs.readJson(itemId)`**: Reads a desktop file and parses its contents as JSON.
  - **Arguments**: `itemId: string`
  - **Returns**: `Promise<any>`
* **`fs.urlFor(itemId)`**: Returns a same-origin loopback URL for the file. Use this to bind media directly to HTML elements (e.g., `<img src="${window.eternal.fs.urlFor(id)}">`).
  - **Arguments**: `itemId: string`
  - **Returns**: `string`
* **`fs.write(opts)`**: Creates a new file or overwrites an existing one. If parent folders in the path do not exist, they are created automatically.
  - **Arguments**: `opts: { path: string, content: string | Blob, mimeType: string }`
  - **Returns**: `Promise<{ id: string, path: string, item: DesktopItem }>`
* **`fs.patch(itemId, updates)`**: Modifies metadata or contents of a desktop file.
  - **Arguments**: `itemId: string, updates: Partial<DesktopItem>`
  - **Returns**: `Promise<DesktopItem>`
* **`fs.delete(itemId)`**: Deletes a desktop item permanently or sends it to the trash.
  - **Arguments**: `itemId: string`
  - **Returns**: `Promise<void>`

### 3.3 Sandboxed Storage (`eternal.storage`)
Provides a fast, private, sandboxed Key-Value database storage space isolated to your specific app ID and user account. This does not touch the desktop filesystem and is ideal for storing local settings, state, or app caches.

* **`storage.get(key)`**: Retrieves a value. Returns `null` if the key does not exist.
  - **Arguments**: `key: string`
  - **Returns**: `Promise<any>`
* **`storage.set(key, value)`**: Saves any serializable value under a key.
  - **Arguments**: `key: string, value: any`
  - **Returns**: `Promise<void>`
* **`storage.delete(key)`**: Removes a key and its associated value.
  - **Arguments**: `key: string`
  - **Returns**: `Promise<void>`
* **`storage.list()`**: Lists all keys stored in the private KV sandbox.
  - **Returns**: `Promise<string[]>`

### 3.4 Inter-App Communication (`eternal.ipc`)
An in-memory real-time message bus mediated by the parent OS frame. Allows any open sandbox apps to publish and subscribe to custom events in real time.

* **`ipc.emit(topic, payload)`**: Broadcasts a message to all other open apps listening on the topic.
  - **Arguments**: `topic: string, payload: any`
* **`ipc.on(topic, callback)`**: Registers a listener for incoming messages on a topic. Returns a cleanup function to unsubscribe.
  - **Arguments**: `topic: string, callback: (payload: any, sender: { appId?: string, previewId?: string }) => void`
  - **Returns**: `() => void` (unsubscribe function)

### 3.5 Outbound Networking Proxy (`eternal.fetch`)
Enables secure HTTP calls to external APIs. Gated by domain-allowlists declared under `permissions.network.outbound` in the app's manifest.

* **`eternal.fetch(url, init)`**: Proxies an HTTP fetch request through a secure same-origin backend to prevent CORS issues.
  - **Arguments**: Identical to standard `fetch(url, init)`
  - **Returns**: `Promise<Response>`-like object (exposes `.status`, `.ok`, `.json()`, `.text()`, and `.blob()`)

### 3.6 Window State Control (`eternal.window`)
Allows apps to dynamically interact with and resize their host windows.

* **`window.setTitle(title)`**: Updates the title bar text of the host window in real time.
  - **Arguments**: `title: string`
* **`window.resize(width, height)`**: Resizes the host window dynamically.
  - **Arguments**: `width: number, height: number`
* **`window.requestFocus()`**: Visual focus pull (brings window to the foreground).
* **`window.close()`**: Closes the application window programmatically.

---

## 4. Manifest Configuration (`eternal.app.json`)

The manifest defines metadata, permissions, and extension handlers:

```json
{
  "name": "Note Editor",
  "description": "Create and edit rich text notes on your desktop.",
  "version": "1.0.0",
  "windowConfig": {
    "defaultWidth": 700,
    "defaultHeight": 550,
    "resizable": true
  },
  "permissions": {
    "fs": {
      "read": ["/Notes/**"],
      "write": ["/Notes/**"],
      "delete": ["/Notes/**"],
      "mimeTypes": ["text/plain", "application/json"]
    },
    "profile": {
      "read": ["username", "displayName"]
    },
    "network": {
      "outbound": ["api.weather.gov", "api.github.com"]
    }
  },
  "fileHandlers": [
    {
      "extension": "txt",
      "mimeType": "text/plain",
      "icon": "📝"
    }
  ]
}
```

### 4.1 Permissions Schema Explained
- **`fs.read` / `fs.write` / `fs.delete`**: Globs indicating which desktop paths the app can interact with. For example, `["/Notes/**"]` allows recursively managing any items inside a `/Notes` desktop folder. `["/**"]` grants full desktop access.
- **`fs.mimeTypes`**: Limits operations to specific file formats (e.g. `["text/plain", "image/*"]`).
- **`profile.read`**: Allowlisted fields you can query from `eternal.profile.get()`.
- **`network.outbound`**: Hostnames (without `http://` or paths) the app is permitted to fetch.

### 4.2 File Openers (File Handlers)
By declaring a `fileHandlers` array, your app registers as a default opener for matching files on the desktop:
- When a user double-clicks a matching `.txt` file, the OS launches your app.
- The OS appends the double-clicked item's file ID in the iframe query string: `?fileId=abc-123-uuid`.
- **App Logic implementation**:
  ```javascript
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get('fileId');
  if (fileId) {
    // Read the file and load it in your interface
    const content = await window.eternal.fs.readText(fileId);
    document.getElementById('editor').value = content;
  }
  ```

---

## 5. Hand-in-Hand Collaborative Development Flow (Human + AI)

Because the AI assistant can output structured code but cannot run interactive CLI commands or browse your local file system, follow this collaborative loop to build high-complexity apps at lightning speed.

### Phase 1: Planning and Prompting the AI
Present the AI with your app idea, referencing this handbook. Ask the AI to write the complete implementation code.

*Example Prompt:*
> "I want to build a Markdown Notepad app for EternalOS. It should be able to create, read, and write markdown files under the `/Notes` desktop directory. It should support opening double-clicked `.md` files using launch intents, let the user change the theme (storing the active theme in private KV storage), and allow dynamic window resizing. Write the complete, production-grade files: `eternal.app.json`, `index.html`, and `app.js` using the EternalOS Developer Handbook APIs."

### Phase 2: Local Staging
1. The AI assistant will output the completed code blocks for `eternal.app.json`, `index.html`, and `app.js`.
2. In your terminal, initialize the local directory:
   ```bash
   node scripts/eternal-app.mjs init markdown-editor
   ```
3. Copy the code generated by the AI directly into the corresponding files in the `markdown-editor/` folder.

### Phase 3: The Deployment & Verification Loop
1. Run the CLI tool to push the app to your desktop:
   ```bash
   node scripts/eternal-app.mjs deploy markdown-editor
   ```
2. Open EternalOS in your browser, double-click the new "Markdown Notepad" icon on the desktop, and interact with the app.
3. **If there is a bug or you want to add a feature**:
   - Copy the error log from the browser DevTools Console or describe the behavior you want to improve.
   - Paste it back to the AI assistant:
     > "The markdown editor works, but when I try to save a new note, it says: `Permission Denied: canWriteItem failed`. Here is my current `eternal.app.json` manifest: [paste manifest]. How do I resolve this, and can you also add a search filter to list only `.md` files?"
   - The AI will analyze the permissions schema, output the corrected `eternal.app.json` or modified `app.js` logic.
   - Replace the local files and run `deploy` again:
     ```bash
     node scripts/eternal-app.mjs deploy markdown-editor
     ```
   - In less than 15 seconds, the update is live on your desktop!

---

## 6. Pro Design Tips for Premium Apps

To ensure your custom applications fit beautifully within the premium EternalOS ecosystem:
1. **Adopt Sleek Color Palettes**: Avoid basic, primary colors. Use harmonious dark mode palettes, vibrant accent gradients (e.g., violet-to-emerald or crimson-to-purple), and glassmorphism styling (`backdrop-filter: blur(8px)` combined with semi-transparent background colors).
2. **Handle Dynamic Resizing Gracefully**: Use CSS Flexbox, Grid, and percentage-based sizing. Call `window.eternal.window.resize(w, h)` on mount to establish a perfect initial frame, and let content flow gracefully if the user resizes the window.
3. **Add Micro-Animations**: Use subtle CSS transitions on hover, focus, and click states (e.g. `transition: all 0.2s ease`). A button that glows slightly on hover instantly makes an app feel premium and premium.
4. **Utilize IPC for Synergy**: Build apps that work together! A note editor can publish an event `note:saved` with metadata, and a desktop dashboard widget can subscribe to `note:saved` and dynamically update its recent activity list.
