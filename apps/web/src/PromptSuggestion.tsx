import React, { useRef, useState } from 'react';
import promptMarkUrl from '../../../public/fav-icon.png';
import {
  generatePromptExpansion,
  getKnownReferenceFallback,
  type PromptSuggestionKind,
} from './promptAi.js';

export function expandPrompt(value: string, fallback: string, expansion: string, maxLength = 1200) {
  const source = value.trim().replace(/\s+/g, ' ');
  if (!source) return fallback;

  const cleanSource = source.replace(/[.;,\s]+$/, '');
  const cleanExpansion = expansion.trim();
  if (cleanSource.toLowerCase().includes(cleanExpansion.toLowerCase())) return `${cleanSource}.`;

  return `${cleanSource}. ${cleanExpansion}`.slice(0, maxLength).trimEnd();
}

export function PromptSuggestion({
  value,
  suggestion,
  expansion,
  kind,
  onUse,
  label,
}: {
  value: string;
  suggestion: string;
  expansion: string;
  kind: PromptSuggestionKind;
  onUse: (suggestion: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ai' | 'fallback'>('idle');
  const requestId = useRef(0);
  const hasPrompt = value.trim().length > 0;
  const expandedSuggestion = result || expandPrompt(value, suggestion, expansion);
  const accessibleLabel = label ?? (hasPrompt ? 'Expand this prompt' : 'Show a prompt suggestion');

  async function toggleSuggestion() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);

    if (!hasPrompt) {
      setResult(suggestion);
      setStatus('idle');
      return;
    }

    const currentRequest = ++requestId.current;
    setResult('');
    setStatus('loading');
    try {
      const generated = await generatePromptExpansion(value, kind);
      if (requestId.current !== currentRequest) return;
      setResult(generated);
      setStatus('ai');
    } catch {
      if (requestId.current !== currentRequest) return;
      setResult(getKnownReferenceFallback(value, kind) ?? expandPrompt(value, suggestion, expansion));
      setStatus('fallback');
    }
  }

  return (
    <span className="prompt-suggestion">
      <button
        type="button"
        className="prompt-suggestion-trigger"
        aria-label={accessibleLabel}
        aria-expanded={open}
        aria-busy={status === 'loading'}
        onClick={toggleSuggestion}
      >
        <img src={promptMarkUrl} alt="" aria-hidden="true"/>
      </button>
      {open && (
        <span className={`prompt-suggestion-popover ${status === 'loading' ? 'is-loading' : ''}`} role="note" aria-live="polite">
          <small>
            {status === 'loading'
              ? 'Developing your idea'
              : status === 'ai'
                ? 'AI-developed from your prompt'
                : status === 'fallback'
                  ? 'Structured suggestion · AI unavailable'
                  : 'Example prompt'}
          </small>
          <span>{status === 'loading' ? 'Reading the idea, resolving its references and shaping the film language…' : expandedSuggestion}</span>
          {status !== 'loading' && (
            <button
              type="button"
              className="prompt-suggestion-use"
              onClick={() => {
                onUse(expandedSuggestion);
                setOpen(false);
              }}
            >
              {hasPrompt ? 'Use developed prompt' : 'Use suggestion'}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
