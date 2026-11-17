import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());
describe('API: запросы без тела', () => {
  it.each(['POST', 'DELETE'])(
    '%s без тела не объявляет JSON, который сервер не сможет разобрать',
    async (method) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await api('/api/notes/test/membership/accept', { method });
      const options = fetchMock.mock.calls[0][1] as RequestInit;
      expect(new Headers(options.headers).has('Content-Type')).toBe(false);
      expect(options.body).toBeUndefined();
    },
  );
  it('передаёт JSON-тело с подходящим типом', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/notes/test/members', { method: 'POST', body: '{"role":"reader"}' });
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
    expect(options.body).toBe('{"role":"reader"}');
  });
});
