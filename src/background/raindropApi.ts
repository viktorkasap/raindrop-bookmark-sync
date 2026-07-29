// Raindrop.io API Client

import {
  Collection,
  CreateCollectionData,
  UpdateCollectionData,
  Raindrop,
  CreateRaindropData,
  UpdateRaindropData,
  CollectionsResponse,
  RaindropsResponse,
  RaindropApiResponse,
} from '../types/raindrop';
import ky, { type Options, HTTPError } from 'ky';
import { getApiToken, clearApiToken } from './storage';
import { logger } from '../utils/logger';

const API_BASE_URL = 'https://api.raindrop.io/rest/v1';

// Rate limiting: 120 requests per minute (kept custom — simple sliding window,
// reused as a ky beforeRequest hook).
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120;

class RateLimiter {
  private requests: number[] = [];

  async wait(): Promise<void> {
    const now = Date.now();
    this.requests = this.requests.filter(
      (time) => now - time < RATE_LIMIT_WINDOW
    );

    if (this.requests.length >= MAX_REQUESTS_PER_WINDOW) {
      const oldestRequest = this.requests[0];
      const waitTime = RATE_LIMIT_WINDOW - (now - oldestRequest) + 100;
      logger.debug(`Rate limit reached, waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.requests.push(Date.now());
  }
}

const rateLimiter = new RateLimiter();

async function getAccessToken(): Promise<string> {
  const token = await getApiToken();
  if (!token) {
    throw new Error('Not authenticated. Please add your Test Token in Settings.');
  }
  return token;
}

// ky honors Retry-After on 429/503 natively, does exponential backoff on the
// listed status codes, and retries network errors by default — replacing the
// hand-rolled recursive retry. 401 is deliberately NOT in statusCodes, so it
// never retries; it is handled (token cleared) in the afterResponse hook.
const api = ky.create({
  prefixUrl: API_BASE_URL,
  retry: {
    limit: 3,
    methods: ['get', 'post', 'put', 'delete'],
    statusCodes: [429, 500, 502, 503, 504],
    backoffLimit: 120000,
    // Cap server-provided Retry-After at 120 s (ky's default is Infinity).
    maxRetryAfter: 120000,
  },
  hooks: {
    beforeRequest: [
      async () => {
        await rateLimiter.wait();
      },
      async (request) => {
        const token = await getAccessToken();
        request.headers.set('Authorization', `Bearer ${token}`);
        request.headers.set('Content-Type', 'application/json');
      },
    ],
    afterResponse: [
      async (_request, _options, response) => {
        // Clear the token on 401 as a side-effect; do NOT throw here.
        // Throwing a plain Error from afterResponse causes ky to retry the
        // request (generic errors bypass the statusCodes check). Instead we
        // let ky throw its own HTTPError (401 is not in statusCodes → no
        // retry), and handle the friendly message in the beforeError hook.
        if (response.status === 401) {
          logger.warn('Token is invalid, clearing...');
          await clearApiToken();
        }
      },
    ],
    beforeError: [
      (error: HTTPError) => {
        if (error.response) {
          // Restore the contract the old apiRequest established: attach the HTTP
          // status code directly on the thrown error so downstream consumers
          // (e.g. syncManager's isCollectionNotFoundError) can read `error.status`
          // without knowing about ky's HTTPError shape. ky only exposes status at
          // error.response.status, so we mirror it to the top level here.
          (error as unknown as { status?: number }).status =
            error.response.status;
        }
        if (error.response?.status === 401) {
          // Replace the default HTTPError message with a user-friendly one.
          // We mutate the message so the error stays an HTTPError instance
          // (isHTTPError check in ky's retry logic = no retry for 401).
          error.message =
            'Token invalid. Please check your Test Token in Settings.';
        }
        return error;
      },
    ],
  },
});

async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpoint: string,
  data?: unknown
): Promise<T> {
  // ky forbids a leading slash on the input when prefixUrl is set.
  const path = endpoint.replace(/^\//, '');

  const options: Options = { method };
  if (data && (method === 'POST' || method === 'PUT')) {
    options.json = data;
  }

  logger.debug(`API Request: ${method} ${endpoint}`, data);
  const result = await api(path, options).json<T>();
  logger.debug(`API Response: ${method} ${endpoint}`, result);
  return result as T;
}

// ==================== Collections API ====================

export async function getRootCollections(): Promise<Collection[]> {
  const response = await apiRequest<CollectionsResponse>('GET', '/collections');

  if (!response.result) {
    throw new Error('Failed to get root collections');
  }

  return response.items;
}

export async function getChildCollections(): Promise<Collection[]> {
  const response = await apiRequest<CollectionsResponse>(
    'GET',
    '/collections/childrens'
  );

  if (!response.result) {
    throw new Error('Failed to get child collections');
  }

  return response.items;
}

export async function getAllCollections(): Promise<Collection[]> {
  // Do NOT swallow a childrens failure: callers (reconcileFolderTree) treat
  // absence from this list as "collection deleted" and resurrect — a partial
  // list would mass-create duplicate collections. An account with zero child
  // collections still returns result:true with an empty items array.
  const [root, children] = await Promise.all([
    getRootCollections(),
    getChildCollections(),
  ]);

  // Deduplicate by _id
  const seen = new Set<number>();
  const all: Collection[] = [];

  for (const collection of [...root, ...children]) {
    if (!seen.has(collection._id)) {
      seen.add(collection._id);
      all.push(collection);
    }
  }

  return all;
}

export async function getCollection(id: number): Promise<Collection> {
  const response = await apiRequest<RaindropApiResponse<Collection>>(
    'GET',
    `/collection/${id}`
  );

  if (!response.result || !response.item) {
    throw new Error(`Failed to get collection ${id}`);
  }

  return response.item;
}

export async function createCollection(
  data: CreateCollectionData
): Promise<Collection> {
  const response = await apiRequest<RaindropApiResponse<Collection>>(
    'POST',
    '/collection',
    data
  );

  if (!response.result || !response.item) {
    throw new Error('Failed to create collection');
  }

  return response.item;
}

export async function updateCollection(
  id: number,
  data: UpdateCollectionData
): Promise<Collection> {
  const response = await apiRequest<RaindropApiResponse<Collection>>(
    'PUT',
    `/collection/${id}`,
    data
  );

  if (!response.result || !response.item) {
    throw new Error(`Failed to update collection ${id}`);
  }

  return response.item;
}

export async function deleteCollection(id: number): Promise<void> {
  const response = await apiRequest<RaindropApiResponse<Collection>>(
    'DELETE',
    `/collection/${id}`
  );

  if (!response.result) {
    throw new Error(`Failed to delete collection ${id}`);
  }
}

// ==================== Raindrops API ====================

export async function getRaindrops(
  collectionId: number,
  page = 0,
  perPage = 50
): Promise<Raindrop[]> {
  const response = await apiRequest<RaindropsResponse>(
    'GET',
    `/raindrops/${collectionId}?page=${page}&perpage=${perPage}`
  );

  if (!response.result) {
    throw new Error(`Failed to get raindrops for collection ${collectionId}`);
  }

  return response.items;
}

export async function getAllRaindropsInCollection(
  collectionId: number
): Promise<Raindrop[]> {
  const allRaindrops: Raindrop[] = [];
  let page = 0;
  const perPage = 50;

  while (true) {
    const raindrops = await getRaindrops(collectionId, page, perPage);
    allRaindrops.push(...raindrops);

    if (raindrops.length < perPage) {
      break;
    }

    page++;
  }

  return allRaindrops;
}

export async function getRaindrop(id: number): Promise<Raindrop> {
  const response = await apiRequest<RaindropApiResponse<Raindrop>>(
    'GET',
    `/raindrop/${id}`
  );

  if (!response.result || !response.item) {
    throw new Error(`Failed to get raindrop ${id}`);
  }

  return response.item;
}

export async function createRaindrop(
  data: CreateRaindropData
): Promise<Raindrop> {
  const response = await apiRequest<RaindropApiResponse<Raindrop>>(
    'POST',
    '/raindrop',
    data
  );

  if (!response.result || !response.item) {
    throw new Error('Failed to create raindrop');
  }

  return response.item;
}

export async function createRaindrops(
  items: CreateRaindropData[]
): Promise<Raindrop[]> {
  if (items.length === 0) return [];

  // Raindrop API allows max 100 items per bulk request
  const CHUNK_SIZE = 100;
  const results: Raindrop[] = [];

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const response = await apiRequest<{ result: boolean; items: Raindrop[] }>(
      'POST',
      '/raindrops',
      { items: chunk }
    );

    if (response.result && response.items) {
      results.push(...response.items);
    } else {
      logger.error('Bulk create partially failed', response);
    }
  }

  return results;
}

export async function updateRaindrop(
  id: number,
  data: UpdateRaindropData
): Promise<Raindrop> {
  const response = await apiRequest<RaindropApiResponse<Raindrop>>(
    'PUT',
    `/raindrop/${id}`,
    data
  );

  if (!response.result || !response.item) {
    throw new Error(`Failed to update raindrop ${id}`);
  }

  return response.item;
}

export async function deleteRaindrop(id: number): Promise<void> {
  const response = await apiRequest<RaindropApiResponse<Raindrop>>(
    'DELETE',
    `/raindrop/${id}`
  );

  if (!response.result) {
    throw new Error(`Failed to delete raindrop ${id}`);
  }
}

// ==================== User API ====================

export interface User {
  _id: number;
  email: string;
  fullName: string;
  pro: boolean;
}

export async function getCurrentUser(): Promise<User> {
  const response = await apiRequest<{ result: boolean; user: User }>(
    'GET',
    '/user'
  );

  if (!response.result || !response.user) {
    throw new Error('Failed to get current user');
  }

  return response.user;
}

// ==================== Auth ====================

export async function logout(): Promise<void> {
  await clearApiToken();
  logger.info('Logged out from Raindrop.io');
}
