/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BaseLlmClient } from '@google/gemini-cli-core';
import { LlmRole } from '@google/gemini-cli-core';
import type { VibeOption } from '../components/VibeInput.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_OPTIONS = 3;
const NUM_VARIANTS = 3;

/**
 * Model config key for vibetype suggestion calls.
 * Falls back to the default model; users can override via modelConfig
 * settings if they want a faster/cheaper model for tree generation.
 */
const VIBE_MODEL_CONFIG_KEY = { model: 'vibetype-suggest' };

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * JSON schema passed to generateJson() for structured output.
 * Mirrors the shape vibetype.mjs uses with Ollama.
 */
const VIBE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description: 'Short scannable label, 3–6 words',
          },
          payload: {
            type: 'string',
            description: 'Full standalone prompt sentence the user will send',
          },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                payload: { type: 'string' },
              },
              required: ['label', 'payload'],
            },
            description: 'Alternate phrasings of the same intent',
          },
        },
        required: ['label', 'payload', 'variants'],
      },
    },
  },
  required: ['options'],
};

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  pathContext: Array<{ label: string }>,
  convContext: string,
): string {
  const isRoot = pathContext.length === 0;
  const pathLine = isRoot
    ? ''
    : `\nConversation path so far: ${pathContext.map((p) => p.label).join(' → ')}`;
  const convLine = convContext
    ? `\nConversation context:\n${convContext}\n`
    : '';

  return (
    `You help users compose detailed prompts for AI coding assistants via a ` +
    `menu interface.${convLine}${pathLine}\n\n` +
    `Generate exactly ${NUM_OPTIONS} distinct ` +
    `${isRoot ? 'top-level intent' : 'follow-up refinement'} options` +
    `${convContext && isRoot ? ' relevant to the conversation context above' : ''}. ` +
    `Each option has a primary version plus ${NUM_VARIANTS - 1} alternate phrasings (variants). ` +
    `Payloads should be complete, standalone prompt sentences the user will send to an AI.`
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Returns a generateOptions function bound to GeminiCLI's BaseLlmClient.
 *
 * Usage in InputPrompt:
 *
 *   const config = useConfig();
 *   const generateOptions = useMemo(
 *     () => makeVibeGenerator(config.getBaseLlmClient()),
 *     [config],
 *   );
 *   // Pass generateOptions as a prop to <VibeInput>.
 */
export function makeVibeGenerator(
  baseLlmClient: BaseLlmClient,
): (
  pathContext: Array<{ label: string }>,
  convContext: string,
  abortSignal: AbortSignal,
) => Promise<VibeOption[]> {
  return async (pathContext, convContext, abortSignal) => {
    const prompt = buildPrompt(pathContext, convContext);

    const result = await baseLlmClient.generateJson({
      modelConfigKey: VIBE_MODEL_CONFIG_KEY,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      schema: VIBE_RESPONSE_SCHEMA,
      abortSignal,
      promptId: 'vibetype-suggest',
      role: LlmRole.UTILITY_TOOL,
    });

    // generateJson returns Record<string, unknown>; schema enforcement is on
    // the Gemini side so we assert the expected shape here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const parsed = result as {
      options: Array<{
        label: string;
        payload: string;
        variants: Array<{ label: string; payload: string }>;
      }>;
    };

    return parsed.options.slice(0, NUM_OPTIONS).map((opt) => ({
      variants: [
        { label: opt.label, payload: opt.payload },
        ...opt.variants.slice(0, NUM_VARIANTS - 1),
      ],
      _children: null,
      _loading: false,
      _fetchPromise: null,
      _error: null,
    }));
  };
}

// ─── Context extractor ────────────────────────────────────────────────────────

/**
 * Collapses GeminiCLI's HistoryItem[] into a short plain-text summary
 * to seed context-relevant suggestions.
 *
 * Usage in InputPrompt:
 *   const vibeContext = useMemo(
 *     () => extractConversationContext(uiState.history),
 *     [vibeModeActive], // snapshot at open time, not live
 *   );
 */
export function extractConversationContext(
  history: Array<{ type: string; text?: string }>,
  maxMessages = 6,
  maxCharsPerMessage = 300,
): string {
  return history
    .filter((item) => item.type === 'user' || item.type === 'gemini')
    .slice(-maxMessages)
    .map((item) => {
      const role = item.type === 'user' ? 'user' : 'assistant';
      const text = (item.text ?? '').slice(0, maxCharsPerMessage);
      return `${role}: ${text}`;
    })
    .join('\n');
}
