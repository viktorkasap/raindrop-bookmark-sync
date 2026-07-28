import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  urlsMatch,
  isValidSyncUrl,
  computeBookmarkHash,
  computeRaindropHash,
} from './hash';

// These tests lock in the CURRENT behaviour of the pure helpers.
// They double as the golden baseline for task 004 (swapping normalizeUrl for a
// library): the replacement must keep these outputs identical, or ship with a resync.

describe('normalizeUrl', () => {
  it('lowercases host and protocol', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('strips a trailing slash (but keeps root)', () => {
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('removes tracking params and drops the hash', () => {
    expect(
      normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&fbclid=z&gclid=q#frag')
    ).toBe('https://example.com/a');
  });

  it('sorts query params for stable comparison', () => {
    expect(normalizeUrl('https://example.com/?b=2&a=1')).toBe('https://example.com/?a=1&b=2');
  });

  it('falls back gracefully on an unparseable URL', () => {
    expect(normalizeUrl('not a url//')).toBe('not a url');
  });
});

describe('urlsMatch', () => {
  it('treats URLs differing only by tracking params as equal', () => {
    expect(urlsMatch('https://x.com/p?utm_source=a', 'https://x.com/p')).toBe(true);
  });
  it('distinguishes genuinely different URLs', () => {
    expect(urlsMatch('https://x.com/a', 'https://x.com/b')).toBe(false);
  });
});

describe('isValidSyncUrl', () => {
  it('accepts http(s)', () => {
    expect(isValidSyncUrl('https://example.com')).toBe(true);
    expect(isValidSyncUrl('http://example.com')).toBe(true);
  });
  it('rejects internal / non-web schemes', () => {
    for (const u of ['about:blank', 'chrome://extensions', 'file:///x', 'javascript:0', 'data:text/html,x', '']) {
      expect(isValidSyncUrl(u)).toBe(false);
    }
  });
});

describe('content hashing', () => {
  it('is deterministic', () => {
    expect(computeBookmarkHash('https://x.com', 'Title')).toBe(
      computeBookmarkHash('https://x.com', 'Title')
    );
  });
  it('matches across bookmark/raindrop for the same url+title (so no false "changed")', () => {
    expect(computeBookmarkHash('https://x.com/p?utm_source=a', 'T')).toBe(
      computeRaindropHash('https://x.com/p', 'T')
    );
  });
  it('changes when the title changes', () => {
    expect(computeBookmarkHash('https://x.com', 'A')).not.toBe(
      computeBookmarkHash('https://x.com', 'B')
    );
  });
});
