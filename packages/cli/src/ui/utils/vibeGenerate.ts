/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BaseLlmClient } from '@google/gemini-cli-core';
import { LlmRole } from '@google/gemini-cli-core';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Model config key for vibe suggestion calls.
 * Reuses the prompt-completion alias (gemini-2.5-flash-lite, no thinking
 * budget) — fast and cheap.
 */
const VIBE_MODEL_CONFIG_KEY = { model: 'prompt-completion' };

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** A mode: suggest next prompts based on conversation context. */
const NEXT_PROMPT_OPTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['options'],
  properties: {
    options: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        required: ['label', 'description'],
        properties: {
          label: {
            type: 'string',
            description: 'Short action label, 3–6 words',
          },
          description: {
            type: 'string',
            description:
              'One sentence elaborating on what this prompt would do',
          },
        },
      },
    },
  },
};

/** B mode: clarifying questions to refine a rough draft. */
const CLARIFYING_QUESTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['question', 'header', 'options'],
        properties: {
          question: {
            type: 'string',
            description:
              'A clear, concise clarifying question ending with a question mark',
          },
          header: {
            type: 'string',
            description:
              'Very short label for the question (1-3 words), e.g. "Approach", "Scope"',
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['label', 'description'],
              properties: {
                label: {
                  type: 'string',
                  description: 'Short option label (1-5 words)',
                },
                description: {
                  type: 'string',
                  description: 'Brief elaboration on this option',
                },
              },
            },
          },
        },
      },
    },
  },
};

/** B mode: assemble a refined prompt from a draft + answers. */
const REFINED_PROMPT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description: 'The refined, complete prompt incorporating all the answers',
    },
  },
};

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildNextPromptOptionsPrompt(
  convContext: string,
  workspaceContext: string,
): string {
  const convLine = convContext
    ? `\nRecent conversation:\n${convContext}\n`
    : '';
  const wsLine = workspaceContext
    ? `\nWorkspace context:\n${workspaceContext}\n`
    : '';

  return (
    `You help users compose prompts for an AI coding assistant.${convLine}${wsLine}\n` +
    `Generate 3–5 distinct, actionable follow-up prompts the user might want to send next. ` +
    `Make them specific and relevant to the conversation above. ` +
    `Each option should be something the user can send as-is or with minor edits.`
  );
}

function buildClarifyingQuestionsPrompt(
  draft: string,
  convContext: string,
  workspaceContext: string,
): string {
  const convLine = convContext
    ? `\nRecent conversation:\n${convContext}\n`
    : '';
  const wsLine = workspaceContext
    ? `\nWorkspace context:\n${workspaceContext}\n`
    : '';

  return (
    `You help users refine rough prompts for an AI coding assistant.${convLine}${wsLine}\n` +
    `The user wants to send: "${draft}"\n\n` +
    `Generate 1–3 clarifying questions (in order of importance) to help make this prompt more specific and actionable. ` +
    `Each question should have 2–4 concrete options. ` +
    `Don't ask obvious or generic questions — focus on what would most change the quality of the response.`
  );
}

function buildRefinedPromptPrompt(
  draft: string,
  questionAnswerPairs: Array<{ question: string; answer: string }>,
): string {
  const pairs = questionAnswerPairs
    .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
    .join('\n');

  return (
    `Rewrite this rough prompt into a clear, specific, actionable AI coding assistant prompt.\n\n` +
    `Original draft: "${draft}"\n\n` +
    `Clarifications:\n${pairs}\n\n` +
    `Output ONLY the final prompt text. No preamble, no quotes, no explanation. ` +
    `Incorporate all the clarifications naturally. ` +
    `Use [bracketed placeholders] only if specific details are genuinely unknown.`
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptOption {
  label: string;
  description: string;
}

export interface ClarifyingQuestion {
  question: string;
  header: string;
  options: PromptOption[];
}

export interface VibeGenerator {
  /**
   * A mode: generate suggested next prompts based on conversation context.
   * Used when the user presses Ctrl+Space with an empty input.
   */
  generateNextPromptOptions: (
    convContext: string,
    workspaceContext: string,
    abortSignal: AbortSignal,
  ) => Promise<PromptOption[]>;

  /**
   * B mode: generate clarifying questions to refine a rough draft.
   * Used when the user presses Ctrl+Space with text already in the input.
   */
  generateClarifyingQuestions: (
    draft: string,
    convContext: string,
    workspaceContext: string,
    abortSignal: AbortSignal,
  ) => Promise<ClarifyingQuestion[]>;

  /**
   * B mode: assemble a refined prompt from the draft + question answers.
   */
  assembleRefinedPrompt: (
    draft: string,
    questionAnswerPairs: Array<{ question: string; answer: string }>,
    abortSignal: AbortSignal,
  ) => Promise<string>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export function makeVibeGenerator(baseLlmClient: BaseLlmClient): VibeGenerator {
  return {
    generateNextPromptOptions: async (
      convContext,
      workspaceContext,
      abortSignal,
    ) => {
      const prompt = buildNextPromptOptionsPrompt(
        convContext,
        workspaceContext,
      );
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: NEXT_PROMPT_OPTIONS_SCHEMA,
        abortSignal,
        promptId: 'vibe-next-options',
        role: LlmRole.UTILITY_TOOL,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = result as { options: PromptOption[] };
      return parsed.options.slice(0, 5);
    },

    generateClarifyingQuestions: async (
      draft,
      convContext,
      workspaceContext,
      abortSignal,
    ) => {
      const prompt = buildClarifyingQuestionsPrompt(
        draft,
        convContext,
        workspaceContext,
      );
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: CLARIFYING_QUESTIONS_SCHEMA,
        abortSignal,
        promptId: 'vibe-clarifying-questions',
        role: LlmRole.UTILITY_TOOL,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = result as { questions: ClarifyingQuestion[] };
      return parsed.questions.slice(0, 3);
    },

    assembleRefinedPrompt: async (draft, questionAnswerPairs, abortSignal) => {
      const prompt = buildRefinedPromptPrompt(draft, questionAnswerPairs);
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: REFINED_PROMPT_SCHEMA,
        abortSignal,
        promptId: 'vibe-assemble-prompt',
        role: LlmRole.UTILITY_TOOL,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = result as { prompt: string };
      return parsed.prompt.trim();
    },
  };
}

// ─── Context extractor ────────────────────────────────────────────────────────

/**
 * Collapses GeminiCLI's HistoryItem[] into a short plain-text summary
 * to seed context-relevant suggestions.
 */
export function extractConversationContext(
  history: Array<{ type: string; text?: string }>,
  maxMessages = 6,
  maxCharsPerMessage = 300,
): string {
  const filtered = history.filter(
    (item) =>
      item.type === 'user' ||
      item.type === 'user_shell' ||
      item.type === 'gemini' ||
      item.type === 'gemini_content',
  );
  const recent = filtered.slice(-maxMessages);

  return recent
    .map((item, index) => {
      const role =
        item.type === 'user' || item.type === 'user_shell'
          ? 'user'
          : 'assistant';
      const isLastAssistantMessage =
        role === 'assistant' && index === recent.length - 1;

      const text = isLastAssistantMessage
        ? (item.text ?? '')
        : (item.text ?? '').slice(0, maxCharsPerMessage);

      return `${role}: ${text}`;
    })
    .join('\n');
}
