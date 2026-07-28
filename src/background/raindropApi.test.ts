import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Boundary mocks: storage (token) + global fetch ----

vi.mock('./storage', () => ({
  getApiToken: vi.fn(async () => 'test-token'),
  clearApiToken: vi.fn(async () => {}),
}));

import { getAllCollections, updateCollection } from './raindropApi';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe('updateCollection', () => {
  it('PUTs the title to /collection/{id} and returns the updated item', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ result: true, item: { _id: 5, title: 'Renamed', parent: null } })
    );

    const updated = await updateCollection(5, { title: 'Renamed' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/collection/5');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
  });

  it('throws when the API rejects the update (result:false)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: false }));

    await expect(updateCollection(5, { title: 'X' })).rejects.toThrow();
  });
});

describe('getAllCollections', () => {
  it('propagates a failed child-collections fetch instead of returning a partial list', async () => {
    // A transient failure of GET /collections/childrens must NOT silently
    // yield "root collections only": reconcileFolderTree treats absence from
    // this list as "collection deleted" and resurrects — one swallowed error
    // would mass-create duplicate collections and repoint every child
    // mapping. Partial data is worse than no data here.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/collections/childrens')
        ? jsonResponse({ result: false })
        : jsonResponse({ result: true, items: [{ _id: 1, title: 'Root', parent: null }] })
    );

    await expect(getAllCollections()).rejects.toThrow();
  });
});
