/**
 * OAuth 2.0 authentication for the Google Data Portability API.
 *
 * Credentials are loaded from (in priority order):
 *   1. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET environment variables
 *   2. credentials.json in the current working directory
 *   3. ~/.config/coocle-portability/credentials.json
 *
 * Tokens are persisted to ~/.config/coocle-portability/tokens.json.
 * The OAuth consent page is opened in the system browser; a local HTTP
 * server on port 3456 receives the redirect callback automatically.
 */

import { google } from 'googleapis';
import type { OAuth2Client, Credentials } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import { homedir } from 'os';
import open from 'open';

// ─── Paths ────────────────────────────────────────────────────────────────────

export const CONFIG_DIR = path.join(homedir(), '.config', 'coocle-portability');
const TOKENS_FILE = path.join(CONFIG_DIR, 'tokens.json');
const CREDS_FILE = path.join(CONFIG_DIR, 'credentials.json');

const REDIRECT_PORT = Number(process.env.OAUTH_REDIRECT_PORT ?? 3456);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;

// ─── Resource → Scope map ─────────────────────────────────────────────────────

/** All known Data Portability resource identifiers and their OAuth 2.0 scopes. */
export const RESOURCE_SCOPES: Record<string, string> = {
  'chrome.bookmarks':               'https://www.googleapis.com/auth/dataportability.chrome.bookmarks',
  'chrome.history':                 'https://www.googleapis.com/auth/dataportability.chrome.history',
  'contacts.profile_data':          'https://www.googleapis.com/auth/dataportability.contacts.profile_data',
  'maps.commute_routes':            'https://www.googleapis.com/auth/dataportability.maps.commute_routes',
  'maps.reviews':                   'https://www.googleapis.com/auth/dataportability.maps.reviews',
  'maps.starred_places':            'https://www.googleapis.com/auth/dataportability.maps.starred_places',
  'myactivity.maps':                'https://www.googleapis.com/auth/dataportability.myactivity.maps',
  'myactivity.search':              'https://www.googleapis.com/auth/dataportability.myactivity.search',
  'myactivity.shopping':            'https://www.googleapis.com/auth/dataportability.myactivity.shopping',
  'myactivity.youtube':             'https://www.googleapis.com/auth/dataportability.myactivity.youtube',
  'photos.library':                 'https://www.googleapis.com/auth/dataportability.photos.library',
  'youtube.channel':                'https://www.googleapis.com/auth/dataportability.youtube.channel',
  'youtube.comments':               'https://www.googleapis.com/auth/dataportability.youtube.comments',
  'youtube.playlists':              'https://www.googleapis.com/auth/dataportability.youtube.playlists',
  'youtube.videos':                 'https://www.googleapis.com/auth/dataportability.youtube.videos',
};

// ─── Credential loading ───────────────────────────────────────────────────────

interface GoogleCredentialFile {
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

/**
 * Build an OAuth2Client from environment variables or a credentials.json file.
 * Throws with a helpful message if neither is found.
 */
export async function loadOAuth2Client(): Promise<OAuth2Client> {
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (envId && envSecret) {
    return new google.auth.OAuth2(envId, envSecret, REDIRECT_URI);
  }

  const candidates = [
    path.join(process.cwd(), 'credentials.json'),
    CREDS_FILE,
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf-8');
      const file: GoogleCredentialFile = JSON.parse(raw);
      const keys = file.installed ?? file.web;
      if (!keys) throw new Error('Unrecognised credentials.json shape — expected "installed" or "web" key.');
      return new google.auth.OAuth2(keys.client_id, keys.client_secret, REDIRECT_URI);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Re-throw parse / shape errors so the user gets a useful message.
        throw err;
      }
      // File not found — try next candidate.
    }
  }

  throw new Error(
    'Google OAuth credentials not found.\n\n' +
    'Option A — environment variables (recommended for CI / headless):\n' +
    '  GOOGLE_CLIENT_ID=<id>  GOOGLE_CLIENT_SECRET=<secret>\n\n' +
    'Option B — credentials file:\n' +
    `  Place credentials.json in the working directory\n` +
    `  or at ${CREDS_FILE}\n\n` +
    'See README.md §Setup for how to obtain credentials from Google Cloud Console.'
  );
}

// ─── Token persistence ────────────────────────────────────────────────────────

/** Load previously saved tokens into `client`. Returns true if valid tokens were found. */
export async function loadTokens(client: OAuth2Client): Promise<boolean> {
  try {
    const raw = await fs.readFile(TOKENS_FILE, 'utf-8');
    const tokens: Credentials = JSON.parse(raw);
    client.setCredentials(tokens);
    // We have a refresh token OR an unexpired access token.
    const hasRefresh = Boolean(tokens.refresh_token);
    const notExpired = typeof tokens.expiry_date === 'number' && tokens.expiry_date > Date.now() + 30_000;
    return hasRefresh || notExpired;
  } catch {
    return false;
  }
}

/** Persist the current tokens from `client` to disk. */
export async function saveTokens(client: OAuth2Client): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKENS_FILE, JSON.stringify(client.credentials, null, 2), 'utf-8');
}

/** Delete saved tokens (logout). */
export async function revokeTokens(): Promise<void> {
  try {
    await fs.unlink(TOKENS_FILE);
  } catch {
    // File didn't exist — that's fine.
  }
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

/** Map resource names → Data Portability OAuth scopes. Unknown names are treated as raw scope URLs. */
export function scopesForResources(resources: string[]): string[] {
  return [...new Set(
    resources.map((r) => RESOURCE_SCOPES[r] ?? `https://www.googleapis.com/auth/dataportability.${r}`)
  )];
}

// ─── OAuth flow ───────────────────────────────────────────────────────────────

export interface AuthFlowResult {
  success: boolean;
  message: string;
  authorizedResources?: string[];
}

/**
 * Run the full browser-based OAuth2 consent flow:
 *  1. Start a local HTTP server on REDIRECT_PORT.
 *  2. Open the Google consent page in the system browser.
 *  3. Wait for the callback (with `timeoutMs` deadline).
 *  4. Exchange the code for tokens, save them, return result.
 */
export async function performAuthFlow(
  client: OAuth2Client,
  resources: string[],
  timeoutMs = 120_000,
): Promise<AuthFlowResult> {
  const scopes = scopesForResources(resources);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent', // Force consent screen so we always get a refresh_token.
  });

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (srv: http.Server) => {
      if (timer) clearTimeout(timer);
      srv.close();
    };

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);
        if (reqUrl.pathname !== '/oauth/callback') {
          res.writeHead(404).end('Not found');
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(htmlPage('❌ Authorization failed', `<p>Google returned: <code>${error}</code></p><p>You can close this tab.</p>`));
          cleanup(server);
          resolve({ success: false, message: `Google OAuth error: ${error}` });
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(htmlPage('❌ Missing code', '<p>No authorization code in callback. You can close this tab.</p>'));
          cleanup(server);
          resolve({ success: false, message: 'Missing authorization code in OAuth callback.' });
          return;
        }

        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        await saveTokens(client);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlPage(
          '✅ Authenticated!',
          `<p>Google Data Portability access granted for:</p>
           <ul>${resources.map((r) => `<li><code>${r}</code></li>`).join('')}</ul>
           <p>You can close this tab and return to Claude.</p>`,
        ));
        cleanup(server);
        resolve({ success: true, message: 'Authentication successful.', authorizedResources: resources });
      } catch (err) {
        res.writeHead(500).end('Internal server error');
        cleanup(server);
        reject(err);
      }
    });

    server.on('error', (err) => {
      reject(new Error(
        `Could not start OAuth callback server on port ${REDIRECT_PORT}: ${err.message}\n` +
        'Set OAUTH_REDIRECT_PORT to a different port if it is in use.'
      ));
    });

    server.listen(REDIRECT_PORT, async () => {
      timer = setTimeout(() => {
        cleanup(server);
        reject(new Error(`OAuth flow timed out after ${timeoutMs / 1000}s. Please try again.`));
      }, timeoutMs);

      process.stderr.write(`\nOAuth consent URL (opening in browser):\n${authUrl}\n\n`);

      try {
        await open(authUrl);
      } catch {
        process.stderr.write('Could not open browser automatically. Please visit the URL above manually.\n');
      }
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 1rem;text-align:center}
code{background:#f0f0f0;padding:2px 5px;border-radius:3px}ul{text-align:left}</style>
</head>
<body><h1>${title}</h1>${body}</body>
</html>`;
}
