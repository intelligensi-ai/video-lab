import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { firebaseApp } from './auth.js';
import { api } from './api.js';

export type PromptSuggestionKind =
  | 'film-brief'
  | 'video-scene'
  | 'storyboard-scene'
  | 'negative';

const SYSTEM_INSTRUCTION = `You are the prompt editor for a premium cinematic AI application.
Interpret the user's idea semantically. Recognise and quietly correct obvious misspellings in named
literary, mythological, historical and cultural references. Preserve the user's intent, but do not
copy the visual language, plot inventions or protected characters of a living filmmaker or a
copyrighted modern work. Public-domain source material may be accurately interpreted.

Return only the improved prompt, ready to paste into a generation field. Do not introduce it, quote
it, add headings, mention your research, or explain your choices. Use precise, evocative prose rather
than a checklist.`;

const TASKS: Record<PromptSuggestionKind, string> = {
  'film-brief': `Expand this seed into a coherent original film overview of 140–190 words. Begin with
  a confident one-sentence statement of genre, period, setting and central dramatic premise. Establish
  a clear beginning, escalation and destination; consistent principal characters and locations; visual
  palette, lighting, lens and camera language; tactile material detail; emotional tone; and practical
  continuity rules that can guide every scene. If the seed references a known work, author, myth or
  historical event, identify it accurately and use its genuine high-level themes and narrative context.`,
  'video-scene': `Expand this into one production-ready cinematic shot description of 70–110 words.
  Specify the subject and one clear action, setting, motivated camera movement, lens and framing,
  lighting direction, palette, materials, atmosphere and a deliberate final composition.`,
  'storyboard-scene': `Expand this into one storyboard scene direction of 70–110 words. Describe one
  precise story beat and subject action, motivated camera movement, lens and framing, lighting
  progression, continuity from the preceding image and a final composition that leads naturally into
  the next scene.`,
  negative: `Rewrite this as a concise negative prompt. Group the unwanted image defects, motion
  defects, identity and wardrobe drift, continuity breaks, lighting conflicts, unwanted text and style
  conflicts without adding positive creative direction.`,
};

export function buildPromptExpansionRequest(value: string, kind: PromptSuggestionKind) {
  return `${TASKS[kind]}\n\nUser's seed:\n${value.trim()}`;
}

export function getKnownReferenceFallback(value: string, kind: PromptSuggestionKind) {
  const seed = value.toLowerCase();
  if (kind !== 'film-brief' || !/\bhomer\b/.test(seed) || !/\b(?:odyssey|odyssy|odess?y)\b/.test(seed)) {
    return undefined;
  }

  return `An ancient Greek mythic epic follows Odysseus, a battle-worn king, across a hostile Mediterranean as he struggles home to Ithaca after the Trojan War. His journey begins in the wreckage of victory, escalates through tempests, strange islands, divine obstruction and the cost of his own pride, while Penelope and Telemachus resist the suitors consuming his household. The film moves between the vast danger of the voyage and the intimate suspense of a family holding its identity together, culminating in a wary homecoming, recognition and reckoning. Keep Odysseus weathered, ingenious and morally complicated; Penelope composed and strategically alert; Telemachus visibly maturing. Use sun-bleached limestone, salt-dark timber, oxidised bronze, indigo sea and ember-lit interiors. Shoot landscapes in restrained anamorphic wides with slow, tidal movement; reserve close, shallow-focus lenses for temptation, grief and recognition. Hard Mediterranean daylight yields to smoky oil-lamp chiaroscuro. Preserve scars, woven garments, ship damage, geography, weather direction and the passage of time across every scene.`;
}

function trimAtWord(text: string, maxLength = 1200) {
  const cleaned = text
    .trim()
    .replace(/^["“]|["”]$/g, '')
    .replace(/\s+/g, ' ');
  if (cleaned.length <= maxLength) return cleaned;
  const shortened = cleaned.slice(0, maxLength + 1);
  const lastSpace = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, lastSpace > maxLength * .75 ? lastSpace : maxLength).trimEnd()}.`;
}

export async function generatePromptExpansion(value: string, kind: PromptSuggestionKind) {
  const prompt = `${SYSTEM_INSTRUCTION}\n\n${buildPromptExpansionRequest(value, kind)}`;
  try {
    const result = await api<{ completedPrompt: string; provider: string }>('/v1/prompts/complete', {
      method: 'POST',
      body: JSON.stringify({ prompt, mode: 'expand' }),
    });
    const expanded = trimAtWord(result.completedPrompt);
    if (expanded) return expanded;
  } catch {
    // Fall back to Firebase AI when the Lambda runtime is not connected or ready.
  }

  if (!firebaseApp) {
    throw new Error('AI prompt development is available when Sulphur or Firebase AI is configured.');
  }

  const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
  const model = getGenerativeModel(ai, {
    model: 'gemini-3.6-flash',
    systemInstruction: SYSTEM_INSTRUCTION,
    ...(kind === 'film-brief' ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: {
      maxOutputTokens: kind === 'film-brief' ? 320 : 220,
      temperature: .65,
    },
  });
  const result = await model.generateContent(buildPromptExpansionRequest(value, kind));
  const expanded = trimAtWord(result.response.text());
  if (!expanded) throw new Error('The AI returned an empty prompt.');
  return expanded;
}
