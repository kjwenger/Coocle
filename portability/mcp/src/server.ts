#!/usr/bin/env node
/**
 * Coocle Portability MCP Server
 *
 * Exposes the Google Data Portability API as MCP tools so Claude (or any
 * MCP-compatible AI assistant) can initiate, monitor, and retrieve Google
 * data exports on the user's behalf.
 *
 * Transport: stdio (default for Claude Code integration)
 *
 * Tools
 * ─────
 *  list_available_resources       List all exportable resource types
 *  authenticate                   Start the OAuth2 browser flow
 *  revoke_authentication          Delete saved tokens (logout)
 *  initiate_portability_archive   Start an export job
 *  check_portability_job_status   Poll an export job's state
 *  retrieve_portability_archive   Get signed download URLs (COMPLETE jobs)
 *  retry_portability_archive      Retry a FAILED job
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';

import {
  RESOURCE_SCOPES,
  loadOAuth2Client,
  loadTokens,
  performAuthFlow,
  revokeTokens,
} from './auth.js';
import {
  initiatePortabilityArchive,
  getPortabilityArchiveState,
  retrievePortabilityArchive,
  retryPortabilityArchive,
  type ArchiveState,
} from './api.js';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const RESOURCE_LIST = Object.keys(RESOURCE_SCOPES).join(', ');

const TOOLS: Tool[] = [
  {
    name: 'list_available_resources',
    description:
      'List all Google Data Portability resource types that can be exported, ' +
      'together with their required OAuth scopes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'authenticate',
    description:
      'Authenticate with Google and grant Data Portability access for the requested resources. ' +
      'Opens the system browser for the OAuth2 consent screen. ' +
      'Run this once before using any other tool, or when you need to add new resource scopes.',
    inputSchema: {
      type: 'object',
      properties: {
        resources: {
          type: 'array',
          items: { type: 'string' },
          description:
            `Resource types to authorize. Defaults to ALL resources if omitted. ` +
            `Available: ${RESOURCE_LIST}`,
        },
      },
    },
  },
  {
    name: 'revoke_authentication',
    description:
      'Delete saved Google authentication tokens. ' +
      'Use this to log out, switch accounts, or clear credentials.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'initiate_portability_archive',
    description:
      'Start a Google Data Portability export job for the specified resource types. ' +
      'Returns a job ID. Archive creation typically takes a few minutes. ' +
      'You must be authenticated for the scopes corresponding to each resource.',
    inputSchema: {
      type: 'object',
      required: ['resources'],
      properties: {
        resources: {
          type: 'array',
          items: { type: 'string' },
          description:
            `One or more resource types to export, e.g. ["myactivity.search", "chrome.history"]. ` +
            `Available: ${RESOURCE_LIST}`,
        },
      },
    },
  },
  {
    name: 'check_portability_job_status',
    description:
      'Check the current state of a Data Portability export job. ' +
      'States: IN_PROGRESS → COMPLETE | FAILED | CANCELLED | RETRYING. ' +
      'Poll every 30–60 seconds until COMPLETE.',
    inputSchema: {
      type: 'object',
      required: ['archive_job_id'],
      properties: {
        archive_job_id: {
          type: 'string',
          description: 'Job ID returned by initiate_portability_archive.',
        },
      },
    },
  },
  {
    name: 'retrieve_portability_archive',
    description:
      'Get signed GCS download URLs for a COMPLETE export job. ' +
      '⚠️  For ONE_TIME_ACCESS jobs this call CONSUMES the download grant — ' +
      'download the ZIP files immediately after calling this tool.',
    inputSchema: {
      type: 'object',
      required: ['archive_job_id'],
      properties: {
        archive_job_id: {
          type: 'string',
          description: 'Job ID of a COMPLETE export job.',
        },
      },
    },
  },
  {
    name: 'retry_portability_archive',
    description: 'Retry a FAILED Data Portability export job. Returns a new job ID.',
    inputSchema: {
      type: 'object',
      required: ['archive_job_id'],
      properties: {
        archive_job_id: {
          type: 'string',
          description: 'Job ID of the FAILED job to retry.',
        },
      },
    },
  },
];

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'coocle-portability', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      // ── list_available_resources ──────────────────────────────────────────
      case 'list_available_resources': {
        const rows = Object.entries(RESOURCE_SCOPES)
          .map(([resource, scope]) => `| \`${resource}\` | \`${scope}\` |`)
          .join('\n');
        return text(
          `## Available Google Data Portability Resources\n\n` +
          `| Resource | OAuth Scope |\n` +
          `|----------|-------------|\n` +
          rows
        );
      }

      // ── authenticate ──────────────────────────────────────────────────────
      case 'authenticate': {
        const resources = (args?.resources as string[] | undefined) ?? Object.keys(RESOURCE_SCOPES);
        const client = await loadOAuth2Client();
        const result = await performAuthFlow(client, resources);
        if (result.success) {
          return text(
            `✅ **Authentication successful!**\n\n` +
            `Authorized resources:\n` +
            (result.authorizedResources?.map((r) => `• \`${r}\``).join('\n') ?? '(unknown)')
          );
        }
        return error(`Authentication failed: ${result.message}`);
      }

      // ── revoke_authentication ─────────────────────────────────────────────
      case 'revoke_authentication': {
        await revokeTokens();
        return text('🔓 Saved authentication tokens have been deleted.');
      }

      // ── initiate_portability_archive ──────────────────────────────────────
      case 'initiate_portability_archive': {
        const resources = args?.resources as string[] | undefined;
        if (!resources?.length) {
          return error('`resources` is required and must be a non-empty array.');
        }

        const client = await loadOAuth2Client();
        if (!(await loadTokens(client))) {
          return error('Not authenticated. Run the `authenticate` tool first.');
        }

        const result = await initiatePortabilityArchive(client, resources);
        const isOneTime = result.accessType === 'ONE_TIME_ACCESS';

        return text(
          `✅ **Export job initiated!**\n\n` +
          `**Job ID:** \`${result.archiveJobId}\`\n` +
          `**Access Type:** ${result.accessType}\n\n` +
          (isOneTime
            ? `⚠️  This is a **ONE_TIME_ACCESS** job. The signed download URLs returned by \`retrieve_portability_archive\` can only be fetched **once** — download the files immediately.\n\n`
            : `ℹ️  This is a **RECURRING_ACCESS** job. Download URLs can be retrieved multiple times.\n\n`) +
          `Use \`check_portability_job_status\` with job ID \`${result.archiveJobId}\` to monitor progress.\n` +
          `Archive creation typically takes 1–10 minutes.`
        );
      }

      // ── check_portability_job_status ──────────────────────────────────────
      case 'check_portability_job_status': {
        const archiveJobId = args?.archive_job_id as string | undefined;
        if (!archiveJobId) return error('`archive_job_id` is required.');

        const client = await loadOAuth2Client();
        if (!(await loadTokens(client))) {
          return error('Not authenticated. Run the `authenticate` tool first.');
        }

        const job = await getPortabilityArchiveState(client, archiveJobId);
        const emoji = stateEmoji(job.state);

        const lines: string[] = [
          `## Export Job Status`,
          '',
          `**Job ID:** \`${job.archiveJobId ?? archiveJobId}\``,
          `**State:** ${emoji} \`${job.state}\``,
        ];
        if (job.createTime) lines.push(`**Created:** ${job.createTime}`);
        if (job.updateTime) lines.push(`**Updated:** ${job.updateTime}`);
        if (job.exportedBytes) lines.push(`**Exported Size:** ${formatBytes(Number(job.exportedBytes))}`);
        if (job.exportedResourceCount) lines.push(`**Resource Count:** ${job.exportedResourceCount}`);

        if (job.resourceAvailabilityInfo?.length) {
          lines.push('', '**Per-Resource Availability:**');
          for (const info of job.resourceAvailabilityInfo) {
            lines.push(`• \`${info.resource}\` ${info.state ? `— ${info.state}` : ''} ${info.resourceSize ? `(${formatBytes(Number(info.resourceSize))})` : ''}`);
          }
        }

        // Action hint based on state.
        const normalised = job.state.toUpperCase();
        if (normalised.includes('COMPLETE')) {
          lines.push('', `✅ Job is complete! Call \`retrieve_portability_archive\` with job ID \`${archiveJobId}\` to get download URLs.`);
        } else if (normalised.includes('FAILED')) {
          lines.push('', `❌ Job failed. Call \`retry_portability_archive\` with job ID \`${archiveJobId}\` to try again.`);
        } else if (normalised.includes('PROGRESS') || normalised === 'ACTIVE') {
          lines.push('', `⏳ Job is still processing. Check again in 30–60 seconds.`);
        }

        return text(lines.join('\n'));
      }

      // ── retrieve_portability_archive ──────────────────────────────────────
      case 'retrieve_portability_archive': {
        const archiveJobId = args?.archive_job_id as string | undefined;
        if (!archiveJobId) return error('`archive_job_id` is required.');

        const client = await loadOAuth2Client();
        if (!(await loadTokens(client))) {
          return error('Not authenticated. Run the `authenticate` tool first.');
        }

        const result = await retrievePortabilityArchive(client, archiveJobId);

        if (!result.signedUrls?.length) {
          return text(`ℹ️  No download URLs returned. The job may not be complete yet, or the one-time access grant has already been used.`);
        }

        const urlLines = result.signedUrls.map(
          (url, i) => `**Part ${i + 1}:** [Download ZIP](${url})\n\`\`\`\n${url}\n\`\`\``
        );

        return text(
          `## Archive Download URLs\n\n` +
          `⚠️  **Download these files now!**\n` +
          `For ONE_TIME_ACCESS jobs, these signed URLs will expire and cannot be regenerated.\n\n` +
          urlLines.join('\n\n')
        );
      }

      // ── retry_portability_archive ─────────────────────────────────────────
      case 'retry_portability_archive': {
        const archiveJobId = args?.archive_job_id as string | undefined;
        if (!archiveJobId) return error('`archive_job_id` is required.');

        const client = await loadOAuth2Client();
        if (!(await loadTokens(client))) {
          return error('Not authenticated. Run the `authenticate` tool first.');
        }

        const result = await retryPortabilityArchive(client, archiveJobId);
        return text(
          `🔄 **Retry initiated!**\n\n` +
          `**New Job ID:** \`${result.archiveJobId}\`\n\n` +
          `Use \`check_portability_job_status\` to monitor progress.`
        );
      }

      default:
        return error(`Unknown tool: "${name}"`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(message);
  }
});

// ─── Response helpers ─────────────────────────────────────────────────────────

function text(content: string): { content: TextContent[] } {
  return { content: [{ type: 'text', text: content }] };
}

function error(message: string): { content: TextContent[]; isError: true } {
  return { content: [{ type: 'text', text: `❌ ${message}` }], isError: true };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function stateEmoji(state: ArchiveState | string): string {
  const s = state.toUpperCase();
  if (s.includes('COMPLETE')) return '✅';
  if (s.includes('FAILED')) return '❌';
  if (s.includes('CANCEL')) return '🚫';
  if (s.includes('RETRY')) return '🔄';
  if (s.includes('PROGRESS') || s === 'ACTIVE') return '⏳';
  return '❓';
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1_024 ** 3).toFixed(2)} GB`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('🚀 Coocle Portability MCP server started (stdio transport)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
