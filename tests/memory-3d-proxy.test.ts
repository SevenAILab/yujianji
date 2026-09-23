import {afterEach, describe, expect, it, vi} from 'vitest';
import {allowedMemoryPath, boundedUpload, proxyMemory} from '../src/lib/memory-3d-proxy';

afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});
const owner = 'a'.repeat(64);
describe('memory 3D gateway', () => {
  it('only permits the public universe operations', () => {
    expect(allowedMemoryPath('jobs', 'POST')).toBe(true);
    expect(allowedMemoryPath(`models/${'b'.repeat(32)}`, 'GET')).toBe(true);
    for (const path of ['../health', 'jobs/../files', 'account/balance', 'models/x', 'jobs?x=1']) {
      expect(allowedMemoryPath(path, 'GET')).toBe(false);
    }
    expect(allowedMemoryPath('jobs', 'DELETE')).toBe(false);
  });
  it('enforces the streaming upload limit without content-length', async () => {
    const body = new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array(21 * 1024 * 1024)); controller.close();
    }});
    const request = new Request('http://localhost/upload', {method: 'POST', body, duplex: 'half'} as RequestInit);
    await expect(boundedUpload(request)).rejects.toThrow('UPLOAD_TOO_LARGE');
  });
  it('adds server credentials, preserves GLB bytes and does not expose secrets', async () => {
    vi.stubEnv('MEMORY_3D_SERVICE_KEY', 'server-only-test');
    const fake = vi.fn().mockResolvedValue(new Response(new Uint8Array([103,108,84,70]), {headers: {'content-type': 'model/gltf-binary'}}));
    vi.stubGlobal('fetch', fake);
    const result = await proxyMemory(new Request('http://localhost/api/memory-3d/models/x', {headers: {'x-universe-id': owner}}), `models/${'b'.repeat(32)}`);
    expect(result.status).toBe(200);
    expect(fake.mock.calls[0][1].headers.get('X-Service-Key')).toBe('server-only-test');
    expect(result.headers.get('X-Service-Key')).toBeNull();
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([103,108,84,70]));
  });
  it('rejects cross-origin writes and missing capability', async () => {
    const fake = vi.fn(); vi.stubGlobal('fetch', fake);
    expect((await proxyMemory(new Request('http://localhost/api', {method:'POST', headers: {'x-universe-id':owner, origin:'https://other.test'}}), 'jobs')).status).toBe(403);
    expect((await proxyMemory(new Request('http://localhost/api'), 'jobs')).status).toBe(401);
    expect(fake).not.toHaveBeenCalled();
  });
});
