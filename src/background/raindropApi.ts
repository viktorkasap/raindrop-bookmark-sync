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
import { getApiToken, clearApiToken } from './storage';
import { logger } from '../utils/logger';

const API_BASE_URL = 'https://api.raindrop.io/rest/v1';

// Rate limiting: 120 requests per minute
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120;
const RETRY_DELAY_BASE = 1000; // 1 second
const MAX_RETRIES = 3;

class RateLimiter {
  private requests: number[] = [];

  async wait(): Promise<void> {
    const now = Date.now();

    // Remove requests older than the window
    this.requests = this.requests.filter(
      (time) => now - time < RATE_LIMIT_WINDOW
    );

    if (this.requests.length >= MAX_REQUESTS_PER_WINDOW) {
      // Calculate wait time
      const oldestRequest = this.requests[0];
      const waitTime = RATE_LIMIT_WINDOW - (now - oldestRequest) + 100;
      logger.debug(`Rate limit reached, waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.requests.push(Date.now());
  }
}

const rateLimiter = new RateLimiter();

interface ApiError extends Error {
  status?: number;
  response?: Response;
}

async function getAccessToken(): Promise<string> {
  const token = await getApiToken();
  if (!token) {
    throw new Error('Not authenticated. Please add your Test Token in Settings.');
  }
  return token;
}

async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpoint: string,
  data?: unknown,
  retryCount = 0
): Promise<T> {
  await rateLimiter.wait();

  const accessToken = await getAccessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (data && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(data);
  }

  const url = `${API_BASE_URL}${endpoint}`;
  logger.debug(`API Request: ${method} ${endpoint}`, data);

  try {
    const response = await fetch(url, options);

    if (response.status === 429) {
      if (retryCount >= MAX_RETRIES) {
        throw new Error(`Rate limited after ${MAX_RETRIES} retries: ${method} ${endpoint}`);
      }
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
      const waitTime = Math.min(retryAfter * 1000, 120000);
      logger.warn(`Rate limited, waiting ${waitTime}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise((resolve) =>
        setTimeout(resolve, waitTime)
      );
      return apiRequest(method, endpoint, data, retryCount + 1);
    }

    if (!response.ok) {
      const error: ApiError = new Error(
        `API request failed: ${response.status} ${response.statusText}`
      );
      error.status = response.status;
      error.response = response;

      // 401 Unauthorized - token is invalid
      if (response.status === 401) {
        logger.warn('Token is invalid, clearing...');
        await clearApiToken();
        throw new Error('Token invalid. Please check your Test Token in Settings.');
      }

      // Retry on server errors
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
        logger.warn(`Server error, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return apiRequest(method, endpoint, data, retryCount + 1);
      }

      throw error;
    }

    const result = await response.json();
    logger.debug(`API Response: ${method} ${endpoint}`, result);
    return result as T;
  } catch (error) {
    // Network error, retry
    if (
      retryCount < MAX_RETRIES &&
      error instanceof TypeError &&
      error.message.includes('fetch')
    ) {
      const delay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
      logger.warn(`Network error, retrying in ${delay}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return apiRequest(method, endpoint, data, retryCount + 1);
    }

    logger.error(`API request failed: ${method} ${endpoint}`, error);
    throw error;
  }
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
  const [root, children] = await Promise.all([
    getRootCollections(),
    getChildCollections().catch(() => []), // childrens may be empty
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
