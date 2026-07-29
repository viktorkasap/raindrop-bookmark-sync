import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Boundary mocks: storage (token) + global fetch ----

vi.mock('./storage', () => ({
  getApiToken: vi.fn(async () => 'test-token'),
  clearApiToken: vi.fn(async () => {}),
}));

import {
  getAllCollections,
  getRootCollections,
  getCollection,
  updateCollection,
} from './raindropApi';
import { clearApiToken, getApiToken } from './storage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(clearApiToken).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('updateCollection (request shape via ky)', () => {
  it('PUTs the title to /collection/{id} with auth header and returns the item', async () => {
    // ky cancels the request body in a finally block after the response is
    // returned, so we clone the request inside the mock to capture the body
    // before it is cancelled.
    let capturedReq: Request | undefined;
    fetchMock.mockImplementation(async (req: Request) => {
      capturedReq = req.clone();
      return jsonResponse({ result: true, item: { _id: 5, title: 'Renamed', parent: null } });
    });

    const updated = await updateCollection(5, { title: 'Renamed' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.url).toBe('https://api.raindrop.io/rest/v1/collection/5');
    expect(req.method).toBe('PUT');
    expect(await capturedReq!.json()).toEqual({ title: 'Renamed' });
    expect(req.headers.get('Authorization')).toBe('Bearer test-token');
    expect(updated.title).toBe('Renamed');
  });

  it('throws when the API rejects the update (result:false)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: false }));
    await expect(updateCollection(5, { title: 'X' })).rejects.toThrow();
  });
});

describe('getAllCollections', () => {
  it('propagates a failed child-collections fetch instead of returning a partial list', async () => {
    fetchMock.mockImplementation(async (req: Request) =>
      req.url.endsWith('/collections/childrens')
        ? jsonResponse({ result: false })
        : jsonResponse({ result: true, items: [{ _id: 1, title: 'Root', parent: null }] })
    );
    await expect(getAllCollections()).rejects.toThrow();
  });
});

describe('retry behavior', () => {
  it('retries on 500 then succeeds (max within 3)', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ result: true, items: [] }));

    const p = getRootCollections();
    await vi.runAllTimersAsync();
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 honoring Retry-After', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '1' } })
      )
      .mockResolvedValueOnce(jsonResponse({ result: true, items: [] }));

    const p = getRootCollections();
    await vi.runAllTimersAsync();
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on network error (fetch rejects) then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ result: true, items: [] }));

    const p = getRootCollections();
    await vi.runAllTimersAsync();
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 retries on persistent 500', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    const p = getRootCollections();
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    // 1 initial + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('401 handling', () => {
  it('clears the token, does NOT retry, and throws the friendly message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(getRootCollections()).rejects.toThrow(
      'Token invalid. Please check your Test Token in Settings.'
    );
    expect(clearApiToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('error .status contract (syncManager compatibility)', () => {
  it('attaches .status = 404 to the thrown error on a 404 response', async () => {
    // 404 is not in ky's retry statusCodes, so it throws immediately — no
    // fake timers needed. Verify that the beforeError hook mirrors
    // error.response.status onto the top-level error.status property so that
    // syncManager's isCollectionNotFoundError check keeps working.
    fetchMock.mockResolvedValue(jsonResponse({ result: false }, 404));

    let caughtError: unknown;
    try {
      await getCollection(9999);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    expect((caughtError as { status?: number }).status).toBe(404);
  });

  it('attaches .status = 401 to the thrown error on a 401 response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    let caughtError: unknown;
    try {
      await getRootCollections();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    expect((caughtError as { status?: number }).status).toBe(401);
  });
});

describe('no-token handling (fail fast, no retry)', () => {
  it('throws "Not authenticated" and never calls fetch when no token is stored', async () => {
    vi.mocked(getApiToken).mockResolvedValueOnce(null);

    await expect(getRootCollections()).rejects.toThrow(
      'Not authenticated. Please add your Test Token in Settings.'
    );
    // The token is fetched before ky, so a missing token fails fast: no network
    // request is made and ky's retry loop never runs (regression guard — a token
    // check inside beforeRequest would be retried 3× while logged out).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
