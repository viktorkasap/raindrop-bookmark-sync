// Hash utilities for change detection

import { nanoid } from 'nanoid';

/**
 * Simple hash function for strings (DJB2 algorithm)
 */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Compute content hash for a bookmark
 */
export function computeBookmarkHash(url: string, title: string): string {
  const content = `${normalizeUrl(url)}|${title.trim()}`;
  return hashString(content);
}

/**
 * Compute content hash for a Raindrop
 */
export function computeRaindropHash(link: string, title: string): string {
  const content = `${normalizeUrl(link)}|${title.trim()}`;
  return hashString(content);
}

/**
 * Normalize URL for comparison
 * - Remove trailing slashes
 * - Convert to lowercase
 * - Remove common tracking parameters
 * - Sort query parameters
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Convert to lowercase
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.protocol = parsed.protocol.toLowerCase();

    // Remove trailing slash from pathname
    if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    // Remove common tracking parameters
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
    ];

    trackingParams.forEach((param) => {
      parsed.searchParams.delete(param);
    });

    // Sort query parameters for consistent comparison
    const params: [string, string][] = [];
    parsed.searchParams.forEach((value, key) => {
      params.push([key, value]);
    });
    params.sort((a, b) => a[0].localeCompare(b[0]));

    const sortedParams = new URLSearchParams();
    params.forEach(([key, value]) => {
      sortedParams.append(key, value);
    });

    parsed.search = sortedParams.toString();

    // Remove hash
    parsed.hash = '';

    return parsed.toString();
  } catch {
    // If URL parsing fails, return the original string normalized
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Check if two URLs are effectively the same
 */
export function urlsMatch(url1: string, url2: string): boolean {
  return normalizeUrl(url1) === normalizeUrl(url2);
}

/**
 * Generate a unique ID (cryptographically strong, 21 chars)
 */
export function generateId(): string {
  return nanoid();
}

/**
 * Check if URL is valid for syncing to Raindrop
 * Filters out internal browser URLs that Raindrop won't accept
 */
export function isValidSyncUrl(url: string): boolean {
  if (!url) return false;

  // Invalid protocols that Raindrop won't accept
  const invalidProtocols = [
    'about:',
    'chrome:',
    'chrome-extension:',
    'moz-extension:',
    'edge:',
    'brave:',
    'opera:',
    'vivaldi:',
    'file:',
    'data:',
    'javascript:',
    'blob:',
  ];

  const lowerUrl = url.toLowerCase();

  for (const protocol of invalidProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      return false;
    }
  }

  // Must have a valid protocol
  if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://')) {
    return false;
  }

  return true;
}
