/**
 * Thin REST client for the Google Data Portability API v1.
 *
 * Reference: https://developers.google.com/data-portability/reference/rest
 *
 * We use the OAuth2Client from google-auth-library for token management
 * (auto-refresh included) and Node 18+ built-in fetch for the HTTP calls.
 */

import type { OAuth2Client } from 'google-auth-library';

const API_BASE = 'https://dataportability.googleapis.com/v1';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AccessType = 'ONE_TIME_ACCESS' | 'RECURRING_ACCESS';

export type ArchiveState =
  | 'PORTABILITY_ARCHIVE_STATE_UNSPECIFIED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'FAILED'
  | 'RETRYING'
  | 'CANCELLED';

export interface InitiateArchiveResponse {
  /** Opaque identifier for the export job. */
  archiveJobId: string;
  /** Whether the signed download URLs can be used once or multiple times. */
  accessType: AccessType;
}

export interface ResourceAvailabilityInfo {
  resource: string;
  resourceSize?: string;
  state?: string;
}

export interface PortabilityArchiveState {
  /** Full resource name, e.g. "portabilityArchive/<id>". */
  name: string;
  archiveJobId?: string;
  state: ArchiveState;
  createTime?: string;
  updateTime?: string;
  exportedBytes?: string;
  exportedResourceCount?: string;
  resourceAvailabilityInfo?: ResourceAvailabilityInfo[];
}

export interface RetrieveArchiveResponse {
  /** Signed GCS download URLs. For ONE_TIME_ACCESS jobs, fetching this response consumes the access. */
  signedUrls: string[];
  name?: string;
}

// ─── Internal fetch wrapper ───────────────────────────────────────────────────

async function apiFetch<T>(
  auth: OAuth2Client,
  method: 'GET' | 'POST',
  endpoint: string,
  body?: unknown,
): Promise<T> {
  // getAccessToken() handles refresh automatically when the token is expired.
  const { token } = await auth.getAccessToken();
  if (!token) {
    throw new Error(
      'No valid access token. Please call the `authenticate` tool first.'
    );
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();

  if (!response.ok) {
    // Try to extract the structured error message from Google's error envelope.
    let detail = text;
    try {
      const envelope = JSON.parse(text) as { error?: { message?: string; status?: string } };
      if (envelope.error?.message) {
        detail = `[${envelope.error.status ?? response.status}] ${envelope.error.message}`;
      }
    } catch {
      /* keep raw text */
    }
    throw new Error(`Google Data Portability API error (HTTP ${response.status}): ${detail}`);
  }

  return JSON.parse(text) as T;
}

// ─── API operations ───────────────────────────────────────────────────────────

/**
 * POST /portabilityArchive:initiate
 * Starts an export job for the given resource types.
 */
export async function initiatePortabilityArchive(
  auth: OAuth2Client,
  resources: string[],
): Promise<InitiateArchiveResponse> {
  return apiFetch<InitiateArchiveResponse>(auth, 'POST', '/portabilityArchive:initiate', { resources });
}

/**
 * GET /portabilityArchive/{archiveJobId}
 * Returns the current state of an export job.
 */
export async function getPortabilityArchiveState(
  auth: OAuth2Client,
  archiveJobId: string,
): Promise<PortabilityArchiveState> {
  return apiFetch<PortabilityArchiveState>(auth, 'GET', `/portabilityArchive/${archiveJobId}`);
}

/**
 * GET /portabilityArchive/{archiveJobId}:retrieve
 * Returns signed download URLs for a COMPLETE job.
 *
 * ⚠️  For ONE_TIME_ACCESS jobs, Google will invalidate the download grant after
 *     this call — the caller must download immediately.
 */
export async function retrievePortabilityArchive(
  auth: OAuth2Client,
  archiveJobId: string,
): Promise<RetrieveArchiveResponse> {
  return apiFetch<RetrieveArchiveResponse>(auth, 'GET', `/portabilityArchive/${archiveJobId}:retrieve`);
}

/**
 * POST /portabilityArchive/{archiveJobId}:retry
 * Retries a FAILED export job. Returns a new job ID.
 */
export async function retryPortabilityArchive(
  auth: OAuth2Client,
  archiveJobId: string,
): Promise<InitiateArchiveResponse> {
  return apiFetch<InitiateArchiveResponse>(auth, 'POST', `/portabilityArchive/${archiveJobId}:retry`, {});
}
