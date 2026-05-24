# Coocle Portability — MCP Server

> **Google Data Portability API → MCP tools for Claude**

Export your Google data (Search history, Chrome, YouTube, Photos, Maps, …) directly
from a Claude conversation. This MCP server wraps the
[Google Data Portability API v1](https://developers.google.com/data-portability/reference/rest)
and exposes it as tools Claude can call.

---

## Available tools

| Tool                           | What it does                                        |
|--------------------------------|-----------------------------------------------------|
| `list_available_resources`     | List all exportable resource types + scopes         |
| `authenticate`                 | OAuth2 browser flow — run once before anything else |
| `revoke_authentication`        | Delete saved tokens (logout / switch accounts)      |
| `initiate_portability_archive` | Start an export job, get a job ID                   |
| `check_portability_job_status` | Poll a job — IN_PROGRESS → COMPLETE / FAILED        |
| `retrieve_portability_archive` | Get signed GCS download URLs for a complete job     |
| `retry_portability_archive`    | Retry a failed job                                  |

---

## Setup

### 1 · Enable the API in Google Cloud Console

1. Go to [Google Cloud Console → APIs & Services](https://console.cloud.google.com/apis/dashboard).
2. Create a project (or reuse **coocle-photos** if you already have one).
3. Search for **"Data Portability API"** and **Enable** it.
4. Go to **Credentials → Create Credentials → OAuth client ID**.
5. Application type: **Desktop app** (or Web with `http://localhost:3456/oauth/callback` as a redirect URI).
6. Download the JSON, rename it `credentials.json`.

> **OAuth consent screen**: for personal use with your own account, **External** type works
> and no Google review is needed. Add your own email as a test user.

### 2 · Place credentials

Either:

**A — file (recommended for local dev)**
```bash
cp credentials.json portability/mcp/credentials.json
# OR globally:
mkdir -p ~/.config/coocle-portability
cp credentials.json ~/.config/coocle-portability/credentials.json
```

**B — environment variables (CI / headless)**
```bash
export GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=your_client_secret
```

See [`credentials.json.example`](./credentials.json.example) for the expected shape.

### 3 · Install & build

```bash
cd portability/mcp
npm install
npm run build
```

### 4 · Wire up Claude Code

Add to your `.claude/settings.json` (project or `~/.claude/settings.json` globally):

```json
{
  "mcpServers": {
    "portability": {
      "command": "node",
      "args": ["/absolute/path/to/Coocle/portability/mcp/dist/server.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "optional-if-using-credentials-file",
        "GOOGLE_CLIENT_SECRET": "optional-if-using-credentials-file"
      }
    }
  }
}
```

Or using `npm run start` if you prefer npm:

```json
{
  "mcpServers": {
    "portability": {
      "command": "npm",
      "args": ["run", "start"],
      "cwd": "/absolute/path/to/Coocle/portability/mcp"
    }
  }
}
```

Restart Claude Code after editing settings.

---

## Usage walkthrough

Once wired up, in any Claude conversation:

```
> Use the authenticate tool for myactivity.search and chrome.history
```
Claude opens your browser → you approve → tokens are saved.

```
> Initiate a portability archive for myactivity.search and chrome.history
```
Claude calls `initiate_portability_archive` → returns a job ID.

```
> Check the status of job abc123
```
Claude polls `check_portability_job_status` → reports COMPLETE.

```
> Retrieve the archive for job abc123
```
Claude calls `retrieve_portability_archive` → returns signed download URLs.

> ⚠️  **ONE_TIME_ACCESS**: For most resource types Google issues one-time-use download
> links. Download your ZIPs immediately after Claude returns the URLs.

---

## Available resources

| Resource                | Description                   |
|-------------------------|-------------------------------|
| `myactivity.search`     | Google Search activity        |
| `myactivity.youtube`    | YouTube watch/search activity |
| `myactivity.maps`       | Google Maps activity          |
| `myactivity.shopping`   | Shopping activity             |
| `chrome.history`        | Chrome browsing history       |
| `chrome.bookmarks`      | Chrome bookmarks              |
| `photos.library`        | Google Photos library         |
| `youtube.channel`       | YouTube channel data          |
| `youtube.comments`      | YouTube comments              |
| `youtube.playlists`     | YouTube playlists             |
| `youtube.videos`        | YouTube uploaded videos       |
| `maps.commute_routes`   | Maps commute routes           |
| `maps.reviews`          | Maps reviews                  |
| `maps.starred_places`   | Maps starred places           |
| `contacts.profile_data` | Google Contacts profile data  |

Run `list_available_resources` in Claude for the full list with OAuth scope strings.

---

## Development

```bash
# Type-check without building
npm run typecheck

# Run directly with tsx (no build step)
npm run dev

# Build to dist/
npm run build
```

### Environment variables

| Variable               | Default | Description                                       |
|------------------------|---------|---------------------------------------------------|
| `GOOGLE_CLIENT_ID`     | —       | OAuth client ID (alternative to credentials.json) |
| `GOOGLE_CLIENT_SECRET` | —       | OAuth client secret                               |
| `OAUTH_REDIRECT_PORT`  | `3456`  | Local port for the OAuth callback server          |

---

## Architecture

```
src/
├── server.ts   MCP server — tool registry + request dispatch
├── auth.ts     OAuth2 flow (browser redirect, token persistence)
└── api.ts      Google Data Portability REST client (fetch + google-auth-library)
```

- **Transport**: stdio (MCP standard for local integrations)
- **Auth**: OAuth2 with PKCE-style local loopback redirect; tokens saved to
  `~/.config/coocle-portability/tokens.json`
- **Deps**: `@modelcontextprotocol/sdk`, `googleapis` (OAuth2Client), `open`

---

## Part of Coocle

This is the `portability/mcp` subproject of
[Coocle](https://github.com/kjwenger/Coocle) — a Google API Cook Out.

See also: [`phrotos/`](../../phrotos) — Google Photos API exploration.
