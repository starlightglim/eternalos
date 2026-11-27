/**
 * Cloudflare Pages Functions Middleware
 *
 * Intercepts /@username requests from social link-preview bots (X, Facebook,
 * Discord, Slack, iMessage, ...) and answers with a minimal HTML page that
 * carries the desktop's OG meta tags, since those bots don't run the SPA.
 * Everyone else — people and search engines, which render JS and get the
 * same tags from useDocumentMeta — passes through to the SPA.
 *
 * Needs the API_URL environment variable on the Pages project (the worker's
 * origin, e.g. https://api.example.com). Without it bots get the SPA's
 * default tags rather than a guessed API host.
 */

export interface Env {
  API_URL?: string;
}

/** The subset of Pages' EventContext this middleware uses. */
export interface MiddlewareContext {
  request: Request;
  env: Env;
  next(): Promise<Response>;
}

// Link-preview (unfurl) bots only. Search crawlers are deliberately absent:
// serving them a different page than people get is cloaking.
const SOCIAL_BOT_PATTERNS = [
  'facebookexternalhit', // Facebook, Instagram, iMessage
  'facebot',
  'twitterbot', // X, iMessage
  'linkedinbot',
  'slackbot', // incl. Slackbot-LinkExpanding
  'discordbot',
  'telegrambot',
  'whatsapp',
  'pinterestbot',
  'redditbot',
  'skypeuripreview', // Teams / Skype
  'vkshare',
  'embedly',
  'iframely',
  'mastodon',
  'cardyb', // Bluesky
  'summalybot', // Misskey
];

export function isSocialBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return SOCIAL_BOT_PATTERNS.some((pattern) => ua.includes(pattern));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** `https://api.example.com/` → `https://api.example.com`; junk → null. */
export function apiOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

interface VisitData {
  username?: string;
  displayName?: string;
  bio?: string;
  shareDescription?: string;
  items?: unknown[];
}

export function renderPreviewPage(pageUrl: string, ogImageUrl: string, username: string, data: VisitData): string {
  const displayName = data.displayName || username;
  const itemCount = data.items?.length || 0;

  // Build description: user's custom shareDescription > bio > default
  const description = data.shareDescription
    || data.bio
    || `${displayName}'s personal desktop on EternalOS - ${itemCount} item${itemCount !== 1 ? 's' : ''} on display.`;

  const pageTitle = `${displayName}'s Desktop - EternalOS`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(pageUrl)}" />

  <!-- OpenGraph -->
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="EternalOS" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />

  <meta name="theme-color" content="#C0C0C0" />
</head>
<body>
  <p><a href="${escapeHtml(pageUrl)}">${escapeHtml(displayName)}'s desktop</a></p>
</body>
</html>`;
}

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  const url = new URL(context.request.url);

  // Only intercept GET/HEAD /@username from social bots
  const method = context.request.method;
  const usernameMatch = url.pathname.match(/^\/@([a-zA-Z0-9_-]+)$/);
  if (!usernameMatch || (method !== 'GET' && method !== 'HEAD')) {
    return context.next();
  }
  if (!isSocialBot(context.request.headers.get('User-Agent') || '')) {
    return context.next();
  }

  const apiBase = apiOrigin(context.env.API_URL);
  if (!apiBase) {
    console.warn('API_URL is not set; social bots get the SPA default meta tags');
    return context.next();
  }

  // Usernames are case-insensitive; one canonical URL per desktop.
  const username = usernameMatch[1].toLowerCase();

  try {
    const visitResponse = await fetch(`${apiBase}/api/visit/${encodeURIComponent(username)}`, {
      headers: { 'User-Agent': 'EternalOS-Middleware/1.0' },
    });

    if (!visitResponse.ok) {
      // User not found or error — pass through to SPA
      return context.next();
    }

    const data = await visitResponse.json() as VisitData;
    const pageUrl = `${url.origin}/@${username}`;
    const ogImageUrl = `${apiBase}/api/og/${encodeURIComponent(username)}.png`;

    const html = renderPreviewPage(pageUrl, ogImageUrl, username, data);
    return new Response(method === 'HEAD' ? null : html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        Vary: 'User-Agent',
      },
    });
  } catch (error) {
    console.error('Middleware error fetching user data:', error);
    return context.next();
  }
};
