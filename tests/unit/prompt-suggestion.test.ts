import { describe, expect, it } from 'vitest';
import { expandPrompt } from '../../apps/web/src/PromptSuggestion.js';
import {
  buildPromptExpansionRequest,
  getKnownReferenceFallback,
} from '../../apps/web/src/promptAi.js';

describe('prompt suggestion expansion', () => {
  it('uses the example when the field is empty', () => {
    expect(expandPrompt('', 'Example prompt', 'Add cinematic detail.')).toBe('Example prompt');
  });

  it('expands text already written by the user', () => {
    expect(expandPrompt('A fox crosses the road', 'Example prompt', 'Add camera and lighting detail.'))
      .toBe('A fox crosses the road. Add camera and lighting detail.');
  });

  it('asks the model to resolve referenced source material in a film brief', () => {
    const request = buildPromptExpansionRequest('A film like The odyssy by homer', 'film-brief');
    expect(request.replace(/\s+/g, ' ')).toContain('known work, author, myth or historical event');
    expect(request).toContain('A film like The odyssy by homer');
  });

  it('provides an accurate Odyssey overview if the AI service is unavailable', () => {
    const fallback = getKnownReferenceFallback('A film like The odyssy by homer', 'film-brief');
    expect(fallback).toMatch(/^An ancient Greek mythic epic/);
    expect(fallback).toContain('Odysseus');
    expect(fallback).toContain('Penelope and Telemachus');
    expect(fallback).toContain('anamorphic');
  });
});
