import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../apps/api/src/index.js';

describe('credit-free generation', () => {
  it('accepts a generation without reserving or charging credits', async () => {
    const response = await request(app)
      .post('/v1/generations')
      .set({ authorization: 'Bearer credit-free-user' })
      .set('Idempotency-Key', 'credit-free-generation-1')
      .send({
        prompt: 'A cinematic test film generated without a credit balance',
        settings: { aspectRatio: '16:9', durationSeconds: 4, quality: 'draft' },
      })
      .expect(201);

    expect(response.body.creditCost).toBe(0);
  });
});
