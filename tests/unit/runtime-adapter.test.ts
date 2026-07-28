import { describe, expect, it, vi } from 'vitest';
import { SulphurLtxRuntimeAdapter } from '@video-lab/runtime-adapter';

describe('sulphur runtime adapter', () => {
  it('rewrites prompts through the confirmed provider route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rewrittenPrompt: 'rewritten storyboard prompt' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const adapter = new SulphurLtxRuntimeAdapter({ baseUrl: 'https://sulphur.example', token: 'secret' });
    const result = await adapter.rewritePrompt?.({
      prompt: 'A cinematic reveal of a glass monolith',
      mode: 'Storyboard',
      negativePrompt: 'blurry',
      enhancePrompt: true,
    });

    expect(result).toEqual({ rewrittenPrompt: 'rewritten storyboard prompt' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://sulphur.example/prompts/rewrite',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer secret',
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('rejects rewrite responses that do not contain rewrittenPrompt', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'fallback text' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const adapter = new SulphurLtxRuntimeAdapter({ baseUrl: 'https://sulphur.example', token: 'secret' });
    await expect(adapter.rewritePrompt?.({ prompt: 'A cinematic reveal of a glass monolith' })).rejects.toThrow('Sulphur rewrite failed');
    vi.unstubAllGlobals();
  });

  it('does not expose a local rewrite fallback', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rewrittenPrompt: 'rewritten' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const adapter = new SulphurLtxRuntimeAdapter({ baseUrl: 'https://sulphur.example', token: 'secret' });
    const result = await adapter.rewritePrompt?.({ prompt: 'A cinematic reveal of a glass monolith' });
    expect(result).toEqual({ rewrittenPrompt: 'rewritten' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
