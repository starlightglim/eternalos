#!/usr/bin/env node

/**
 * EternalOS Developer CLI Utility
 * 
 * Scaffolds new applications locally and deploys them directly to your
 * EternalOS Desktop.
 * 
 * Commands:
 *   node scripts/eternal-app.mjs init <dir-name>        — Scaffolds a new app
 *   node scripts/eternal-app.mjs config <jwt-token>     — Sets your authentication JWT
 *   node scripts/eternal-app.mjs deploy <dir-name> [appId] — Deploys/Updates the app
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, '../.eternal-config.json');

const args = process.argv.slice(2);
const command = args[0];

function logSuccess(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}

function logError(msg) {
  console.error(`\x1b[31m✘ Error: ${msg}\x1b[0m`);
}

function logInfo(msg) {
  console.log(`\x1b[34mℹ ${msg}\x1b[0m`);
}

function printHelp() {
  console.log(`
\x1b[35m🌌 EternalOS App Developer CLI\x1b[0m
====================================
Use this tool to build apps locally and deploy them to your EternalOS desktop!

\x1b[1mCommands:\x1b[0m
  \x1b[36minit <dir-name>\x1b[0m         Scaffold a new sandbox app in a local directory
  \x1b[36mconfig <jwt-token>\x1b[0m      Set your developer JWT Bearer token
  \x1b[36mdeploy <dir-name> [id]\x1b[0m  Bundle and deploy your local app directory to your desktop
`);
}

// ---------------------------------------------------------------------------
// Main Command Router
// ---------------------------------------------------------------------------

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

switch (command) {
  case 'init': {
    const dirName = args[1];
    if (!dirName) {
      logError('Please specify a directory name: node scripts/eternal-app.mjs init <dir-name>');
      process.exit(1);
    }
    initProject(dirName);
    break;
  }
  case 'config': {
    const token = args[1];
    if (!token) {
      logError('Please specify your JWT token: node scripts/eternal-app.mjs config <jwt-token>');
      process.exit(1);
    }
    saveConfig({ token });
    logSuccess('Configuration token saved successfully.');
    break;
  }
  case 'deploy': {
    const dirName = args[1];
    const appId = args[2];
    if (!dirName) {
      logError('Please specify the directory to deploy: node scripts/eternal-app.mjs deploy <dir-name> [appId]');
      process.exit(1);
    }
    deployProject(dirName, appId);
    break;
  }
  default:
    logError(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Business Logic Functions
// ---------------------------------------------------------------------------

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logError(`Failed to save configuration: ${e.message}`);
    process.exit(1);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    logError('Configuration missing! Please set your JWT token first: node scripts/eternal-app.mjs config <jwt-token>');
    logInfo('You can copy your JWT from the Developer Tools Network tab or local storage while logged in to EternalOS.');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    logError(`Failed to load config: ${e.message}`);
    process.exit(1);
  }
}

function initProject(dirName) {
  const projectDir = path.join(process.cwd(), dirName);
  if (fs.existsSync(projectDir)) {
    logError(`Directory "${dirName}" already exists!`);
    process.exit(1);
  }

  logInfo(`Scaffolding new EternalOS app project in ${dirName}...`);

  fs.mkdirSync(projectDir, { recursive: true });

  const manifest = {
    name: dirName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description: "A secure sandboxed app running on EternalOS.",
    version: "1.0.0",
    windowConfig: {
      defaultWidth: 600,
      defaultHeight: 500,
      resizable: true
    },
    permissions: {
      fs: {
        read: ["/**"],
        write: ["/**"],
        delete: ["/**"]
      },
      profile: {
        read: ["username", "displayName"]
      }
    }
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EternalOS Sandbox App</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #1a1a2e;
      color: #e2e2e2;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: #162447;
      padding: 24px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }
    h1 {
      margin-top: 0;
      color: #e43f5a;
    }
    button {
      background: #e43f5a;
      border: none;
      color: white;
      padding: 10px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
      margin-top: 12px;
    }
    button:hover {
      background: #ff4a68;
    }
    pre {
      background: #1f4068;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1 id="app-title">Hello, Sandboxed App!</h1>
    <p>Welcome to your custom local app project. This is fully sandbox-gated.</p>
    
    <div>
      <h3>Filesystem Interaction</h3>
      <button id="write-file-btn">Create Test Note</button>
      <button id="list-files-btn">List My Files</button>
    </div>

    <div>
      <h3>Sandbox KV Storage</h3>
      <button id="save-kv-btn">Save Key</button>
      <button id="read-kv-btn">Read Key</button>
    </div>

    <div>
      <h3>IPC & Network Fetch</h3>
      <button id="fetch-btn">Proxy Fetch Weather</button>
      <button id="resize-btn">Resize Window</button>
    </div>

    <h4>Output Log:</h4>
    <pre id="output">App ready. Exposed under window.eternal</pre>
  </div>
  
  <script type="module" src="./app.js"></script>
</body>
</html>`;

  const js = `// Local app entrypoint utilizing window.eternal bridge APIs
const logEl = document.getElementById('output');
const titleEl = document.getElementById('app-title');

function log(msg) {
  logEl.textContent = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : String(msg);
}

// 1. Load user profile on startup
if (window.eternal) {
  window.eternal.profile.get().then(profile => {
    if (profile.displayName) {
      titleEl.textContent = \`Hello, \${profile.displayName}!\`;
    }
  });
}

// 2. Write file to desktop
document.getElementById('write-file-btn').addEventListener('click', async () => {
  try {
    log('Writing file to desktop...');
    const result = await window.eternal.fs.write({
      path: '/Notes/sandbox-test.txt',
      content: \`Sandbox file generated at \${new Date().toLocaleTimeString()}\`,
      mimeType: 'text/plain'
    });
    log(\`Successfully created file! Path: \${result.path} (ID: \${result.id})\`);
  } catch (err) {
    log(\`Error: \${err.message}\`);
  }
});

// 3. List desktop files
document.getElementById('list-files-btn').addEventListener('click', async () => {
  try {
    log('Listing desktop files...');
    const result = await window.eternal.fs.list();
    log(result);
  } catch (err) {
    log(\`Error: \${err.message}\`);
  }
});

// 4. Save key-value storage
document.getElementById('save-kv-btn').addEventListener('click', async () => {
  try {
    log('Saving key inside sandbox storage...');
    await window.eternal.storage.set('click-count', 'Click value saved!');
    log('Key Click-count stored successfully.');
  } catch (err) {
    log(\`Error: \${err.message}\`);
  }
});

// 5. Read key-value storage
document.getElementById('read-kv-btn').addEventListener('click', async () => {
  try {
    log('Reading key from sandbox storage...');
    const val = await window.eternal.storage.get('click-count');
    log(\`Retrieved value: "\${val}"\`);
  } catch (err) {
    log(\`Error: \${err.message}\`);
  }
});

// 6. Outbound Fetch Proxy
document.getElementById('fetch-btn').addEventListener('click', async () => {
  try {
    log('Making outbound weather fetch proxy request...');
    // weather.gov requires a user-agent header
    const res = await window.eternal.fetch('https://api.weather.gov/points/39.7456,-97.0892', {
      headers: { 'User-Agent': 'EternalOSDevApp' }
    });
    const data = await res.json();
    log(data.properties?.forecast || 'Weather forecast link loaded successfully!');
  } catch (err) {
    log(\`Error: \${err.message}\`);
  }
});

// 7. Dynamic Window Resizing
document.getElementById('resize-btn').addEventListener('click', () => {
  log('Resizing host window...');
  window.eternal.window.resize(900, 700);
});
`;

  fs.writeFileSync(path.join(projectDir, 'eternal.app.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(projectDir, 'index.html'), html);
  fs.writeFileSync(path.join(projectDir, 'app.js'), js);

  logSuccess(`Project scaffolded successfully in "${dirName}".`);
  logInfo(`To deploy, configure your token first, then run:`);
  console.log(`  \x1b[33mnode scripts/eternal-app.mjs deploy ${dirName}\x1b[0m`);
}

async function deployProject(dirName, appId) {
  const projectDir = path.join(process.cwd(), dirName);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    logError(`Project directory "${dirName}" not found!`);
    process.exit(1);
  }

  const manifestPath = path.join(projectDir, 'eternal.app.json');
  if (!fs.existsSync(manifestPath)) {
    logError('Project missing "eternal.app.json" manifest!');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    logError(`Failed to parse manifest: ${e.message}`);
    process.exit(1);
  }

  // Load all files inside directory
  const files = {};
  const dirFiles = fs.readdirSync(projectDir);
  for (const file of dirFiles) {
    if (file === 'eternal.app.json') continue;
    const filePath = path.join(projectDir, file);
    if (fs.statSync(filePath).isFile()) {
      files[file] = fs.readFileSync(filePath, 'utf8');
    }
  }

  const htmlEntry = Object.keys(files).find(f => f.endsWith('.html'));
  if (!htmlEntry) {
    logError('Deployment bundle must include at least one HTML file!');
    process.exit(1);
  }

  const config = loadConfig();
  const base = process.env.VITE_API_URL || 'http://localhost:8787';

  logInfo(`Deploying workspace "${manifest.name}" to EternalOS at ${base}...`);

  try {
    const res = await fetch(`${base}/api/apps/dev-deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`
      },
      body: JSON.stringify({
        appId,
        manifest,
        files
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Deployment failed with status ${res.status}`);
    }

    logSuccess(`App "${manifest.name}" deployed successfully!`);
    logSuccess(`App ID: ${data.appId}`);
    logSuccess(`Version: ${data.version}`);
    logInfo(`The app has been placed directly on your EternalOS desktop.`);
  } catch (err) {
    logError(`Deployment failed: ${err.message}`);
    process.exit(1);
  }
}
