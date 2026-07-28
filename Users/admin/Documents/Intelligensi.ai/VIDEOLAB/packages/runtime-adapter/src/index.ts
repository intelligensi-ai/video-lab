"import { RuntimeAdapter } from './adapter';

export const runtime = new RuntimeAdapter();

runtime.rewritePrompt = async (text: string) => {
  // Mock Sulphur integration
  return { rewrittenPrompt: `Rewritten: ${text}` };
};
"