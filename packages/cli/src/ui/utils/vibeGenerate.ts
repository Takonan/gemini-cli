/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BaseLlmClient } from '@google/gemini-cli-core';
import { LlmRole } from '@google/gemini-cli-core';
import type { VibeOption } from '../components/VibeInput.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_OPTIONS = 3;
const NUM_VARIANTS = 3;

/**
 * Model config key for vibetype suggestion calls.
 * Reuses the prompt-completion alias (gemini-2.5-flash-lite, no thinking
 * budget) — fast and cheap, ideal for background tree generation.
 */
const VIBE_MODEL_CONFIG_KEY = { model: 'prompt-completion' };

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

const VIBE_REFINEMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    refinements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
        },
        required: ['label'],
      },
    },
  },
  required: ['refinements'],
};

const VIBE_CONTINUATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    continuations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          chunk: { type: 'string' },
        },
        required: ['label', 'chunk'],
      },
    },
  },
  required: ['continuations'],
};

const VIBE_TEXT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
};

const VIBE_CHUNK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    chunk: { type: 'string' },
  },
  required: ['chunk'],
};

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildOptionsPrompt(
  pathContext: Array<{ label: string }>,
  convContext: string,
  workspaceContext?: string,
): string {
  const isRoot = pathContext.length === 0;
  const pathLine = isRoot
    ? ''
    : `\nConversation path so far: ${pathContext.map((p) => p.label).join(' → ')}`;
  const convLine = convContext
    ? `\nConversation context:\n${convContext}\n`
    : '';
  const wsLine =
    isRoot && workspaceContext
      ? `\nWorkspace context (git status/files):\n${workspaceContext}\n`
      : '';

  return (
    `You help users compose detailed prompts for AI coding assistants via a ` +
    `menu interface.${convLine}${wsLine}${pathLine}\n\n` +
    `Generate exactly ${NUM_OPTIONS} distinct ` +
    `${isRoot ? 'top-level intent' : 'follow-up refinement'} options` +
    `${(convContext || workspaceContext) && isRoot ? ' relevant to the conversation and workspace context above' : ''}. ` +
    `Each option has a primary version plus ${NUM_VARIANTS - 1} alternate phrasings (variants). ` +
    `Payloads should be complete, standalone prompt sentences the user will send to an AI.`
  );
}

function summarizeFile(fileName: string, content: string): string {
  const lines = content.split('\n');
  if (lines.length <= 100) return content;

  const imports = lines
    .filter((l) => l.startsWith('import '))
    .slice(0, 10)
    .join('\n');
  const exports = lines
    .filter((l) => l.includes('export '))
    .slice(0, 10)
    .join('\n');
  const head = lines.slice(0, 20).join('\n');
  const tail = lines.slice(-20).join('\n');

  return `[File: ${fileName} (Truncated)]\n${imports}\n\n${exports}\n\n${head}\n...\n${tail}`;
}

function buildRefinementsPrompt(
  convContext: string,
  paragraph: string,
  targetSentence?: string,
  workspaceContext?: string,
): string {
  const contextLine = convContext
    ? `Conversation context: ${convContext}\n`
    : '';
  const wsLine = workspaceContext
    ? `Workspace context: ${workspaceContext}\n`
    : '';
  const targetLine = targetSentence
    ? `Target Sentence to improve: "${targetSentence.trim()}"\n`
    : '';

  return (
    `AI prompt editor.${contextLine}${wsLine}\nDraft: "${paragraph}"\n${targetLine}\n` +
    `Generate 6 short, specific editorial directions to improve this prompt. ` +
    `Make each direction concrete and different (tone, content, structure, specificity, etc.). ` +
    `Examples: "Add a specific file path", "Make it more concise", "Lead with a clear goal", "Mention a specific library", "More conversational tone".`
  );
}

function buildContinuationsPrompt(
  convContext: string,
  draft: string,
  intentLabel: string,
  comment?: string,
  workspaceContext?: string,
): string {
  const contextLine = convContext
    ? `Conversation context: ${convContext}\n`
    : '';
  const wsLine = workspaceContext
    ? `Workspace context: ${workspaceContext}\n`
    : '';
  const directionLine = comment ? `Direction: ${comment}\n` : '';

  return (
    `AI prompt drafting.${contextLine}${wsLine}\nCurrent draft: "${draft}"\n` +
    `Angle: ${intentLabel}\n${directionLine}\n` +
    `Generate 5 distinct options for the NEXT 1-2 sentences of this AI prompt. ` +
    `Each with a specific short label and actual prose.`
  );
}

function buildParagraphPrompt(
  convContext: string,
  intentLabel: string,
  comment?: string,
  targetSentence?: string,
  fullContext?: string,
  isContinuation?: boolean,
  workspaceContext?: string,
): string {
  const contextLine = convContext
    ? `Conversation context: ${convContext}\n`
    : '';
  const wsLine = workspaceContext
    ? `Workspace context: ${workspaceContext}\n`
    : '';

  if (targetSentence && fullContext) {
    return (
      `AI prompt drafting.${contextLine}${wsLine}\n` +
      `Rewrite this single sentence from an AI coding assistant prompt.\n` +
      `Original sentence: "${targetSentence.trim()}"\nDirection: "${comment}"\n\n` +
      `Output ONLY the rewritten sentence. No preamble, no explanation, nothing else.`
    );
  }

  if (fullContext && comment && !isContinuation) {
    return (
      `AI prompt drafting.${contextLine}${wsLine}\nCurrent draft: "${fullContext}"\n` +
      `Direction: "${comment}"\n\n` +
      `TASK: Rewrite the draft incorporating the direction. Output ONLY the final prose. ` +
      `No preamble, no explanation, no quotes around it. ` +
      `If specific details are missing, use [bracketed placeholders] like [file path] or [error message] rather than inventing them.`
    );
  }

  if (isContinuation) {
    return (
      `AI prompt drafting.${contextLine}${wsLine}\nCurrent draft: "${fullContext}"\n` +
      `Angle: ${intentLabel}\n${comment ? `Direction: ${comment}` : ''}\n\n` +
      `TASK: Write the next 1-2 sentences continuing the draft. Output ONLY the new sentences. No preamble, no explanation. ` +
      `Use [bracketed placeholders] like [variable name] if specific details are needed.`
    );
  }

  return (
    `AI prompt drafting.${contextLine}${wsLine}\nAngle: ${intentLabel}\n` +
    `${comment ? `Direction: ${comment}` : ''}\n\n` +
    `TASK: Write 1-2 opening sentences for this AI prompt. Output ONLY the prose. No preamble, no explanation. ` +
    `Use [bracketed placeholders] like [project description] or [framework] if specific details are needed.`
  );
}

function buildPlaceholderPrompt(
  paragraph: string,
  phText: string,
  roughValue: string,
  workspaceContext?: string,
): string {
  const idx = paragraph.indexOf(phText);
  const windowStart = Math.max(0, idx - 120);
  const windowEnd = Math.min(paragraph.length, idx + phText.length + 120);
  const context = paragraph.slice(windowStart, windowEnd);
  const wsLine = workspaceContext
    ? `Workspace context: ${workspaceContext}\n`
    : '';

  return (
    `AI prompt editing.\n${wsLine}Context: "...${context}..."\nPlaceholder: ${phText}\n` +
    `Rough value to express: "${roughValue}"\n\n` +
    `TASK: Output ONLY the replacement text — a word, phrase, or short clause that fits naturally where ${phText} appears. ` +
    `Polish the rough value into proper prompt language. No preamble, no full sentences unless the placeholder spans one.`
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface VibeGenerator {
  generateOptions: (
    pathContext: Array<{ label: string }>,
    convContext: string,
    abortSignal: AbortSignal,
    workspaceContext?: string,
  ) => Promise<VibeOption[]>;
  generateRefinements: (
    convContext: string,
    paragraph: string,
    targetSentence?: string,
    abortSignal?: AbortSignal,
    workspaceContext?: string,
  ) => Promise<Array<{ label: string }>>;
  generateContinuations: (
    convContext: string,
    draft: string,
    intentLabel: string,
    comment?: string,
    abortSignal?: AbortSignal,
    workspaceContext?: string,
  ) => Promise<Array<{ label: string; chunk: string }>>;
  generateParagraph: (
    convContext: string,
    intentLabel: string,
    comment?: string,
    targetSentence?: string,
    fullContext?: string,
    isContinuation?: boolean,
    abortSignal?: AbortSignal,
    workspaceContext?: string,
    projectRoot?: string,
  ) => Promise<string>;
  generateParagraphStream: (
    convContext: string,
    intentLabel: string,
    comment?: string,
    targetSentence?: string,
    fullContext?: string,
    isContinuation?: boolean,
    abortSignal?: AbortSignal,
    workspaceContext?: string,
    projectRoot?: string,
  ) => AsyncGenerator<string>;
  fillPlaceholder: (
    paragraph: string,
    phText: string,
    roughValue: string,
    abortSignal?: AbortSignal,
    workspaceContext?: string,
  ) => Promise<string>;
}

/**
 * Returns a VibeGenerator object bound to GeminiCLI's BaseLlmClient.
 */
export function makeVibeGenerator(baseLlmClient: BaseLlmClient): VibeGenerator {
  return {
    generateOptions: async (
      pathContext,
      convContext,
      abortSignal,
      workspaceContext,
    ) => {
      const prompt = buildOptionsPrompt(
        pathContext,
        convContext,
        workspaceContext,
      );
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: VIBE_RESPONSE_SCHEMA,
        abortSignal: abortSignal ?? new AbortController().signal,
        promptId: 'vibe-options',
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
    },

    generateRefinements: async (
      convContext,
      paragraph,
      targetSentence,
      abortSignal,
      workspaceContext,
    ) => {
      const prompt = buildRefinementsPrompt(
        convContext,
        paragraph,
        targetSentence,
        workspaceContext,
      );
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: VIBE_REFINEMENT_SCHEMA,
        abortSignal: abortSignal ?? new AbortController().signal,
        promptId: 'vibe-refinements',
        role: LlmRole.UTILITY_TOOL,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = result as { refinements: Array<{ label: string }> };
      return parsed.refinements.slice(0, 6);
    },

    generateContinuations: async (
      convContext,
      draft,
      intentLabel,
      comment,
      abortSignal,
      workspaceContext,
    ) => {
      const prompt = buildContinuationsPrompt(
        convContext,
        draft,
        intentLabel,
        comment,
        workspaceContext,
      );
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: VIBE_CONTINUATION_SCHEMA,
        abortSignal: abortSignal ?? new AbortController().signal,
        promptId: 'vibe-continuations',
        role: LlmRole.UTILITY_TOOL,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = result as {
        continuations: Array<{ label: string; chunk: string }>;
      };
      return parsed.continuations.slice(0, 5);
    },

    generateParagraph: async (
      convContext,
      intentLabel,
      comment,
      targetSentence,
      fullContext,
      isContinuation,
      abortSignal,
      workspaceContext,
      projectRoot,
    ) => {
      // Resolve @-mentions in the comment or intent label
      let resolvedWsContext = workspaceContext || '';
      const mentionRegex = /@([\w/.-]+)/g;
      const mentions = new Set<string>();
      let m;
      if (comment) {
        while ((m = mentionRegex.exec(comment)) !== null) mentions.add(m[1]);
      }
      if (intentLabel) {
        while ((m = mentionRegex.exec(intentLabel)) !== null)
          mentions.add(m[1]);
      }

      if (mentions.size > 0 && projectRoot) {
        resolvedWsContext += '\n\nReferenced Files:\n';
        for (const mention of mentions) {
          const filePath = path.resolve(projectRoot, mention);
          try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const content = fs.readFileSync(filePath, 'utf8');
              const summary = summarizeFile(mention, content);
              resolvedWsContext += `--- ${mention} ---\n${summary}\n`;
            }
          } catch {
            // Skip unreadable files
          }
        }
      }

      const prompt = buildParagraphPrompt(
        convContext,
        intentLabel,
        comment,
        targetSentence,
        fullContext,
        isContinuation,
        resolvedWsContext,
      );
      const schema = isContinuation ? VIBE_CHUNK_SCHEMA : VIBE_TEXT_SCHEMA;

      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema,
        abortSignal: abortSignal ?? new AbortController().signal,
        promptId: 'vibe-paragraph',
        role: LlmRole.UTILITY_TOOL,
      });

      const parsed = result as { text?: string; chunk?: string };
      return (parsed.text ?? parsed.chunk ?? '').trim();
    },

    async *generateParagraphStream (
      convContext,
      intentLabel,
      comment,
      targetSentence,
      fullContext,
      isContinuation,
      abortSignal,
      workspaceContext,
      projectRoot,
    ) {
      // Resolve @-mentions in the comment or intent label
      let resolvedWsContext = workspaceContext || '';
      const mentionRegex = /@([\w/.-]+)/g;
      const mentions = new Set<string>();
      let m;
      if (comment) {
        while ((m = mentionRegex.exec(comment)) !== null) mentions.add(m[1]);
      }
      if (intentLabel) {
        while ((m = mentionRegex.exec(intentLabel)) !== null)
          mentions.add(m[1]);
      }

      if (mentions.size > 0 && projectRoot) {
        resolvedWsContext += '\n\nReferenced Files:\n';
        for (const mention of mentions) {
          const filePath = path.resolve(projectRoot, mention);
          try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const content = fs.readFileSync(filePath, 'utf8');
              const summary = summarizeFile(mention, content);
              resolvedWsContext += `--- ${mention} ---\n${summary}\n`;
            }
          } catch {
            // Skip unreadable files
          }
        }
      }

      const prompt = buildParagraphPrompt(
        convContext,
        intentLabel,
        comment,
        targetSentence,
        fullContext,
        isContinuation,
        resolvedWsContext,
      );

      const stream = baseLlmClient.generateContentStream({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        abortSignal: abortSignal ?? new AbortController().signal,
        promptId: 'vibe-paragraph-stream',
        role: LlmRole.UTILITY_TOOL,
      });

      let accumulated = '';
      for await (const chunk of stream) {
        const text =
          chunk.candidates?.[0]?.content?.parts?.[0]?.text ||
          chunk.candidates?.[0]?.content?.parts?.[0]?.thought ||
          '';
        accumulated += text;
        yield accumulated;
      }
    },

    fillPlaceholder: async (
      paragraph,
      phText,
      roughValue,
      abortSignal,
      workspaceContext,
    ) => {
      const prompt = buildPlaceholderPrompt(
        paragraph,
        phText,
        roughValue,
        workspaceContext,
      );
      const result = await baseLlmClient.generateJson({
        modelConfigKey: VIBE_MODEL_CONFIG_KEY,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: VIBE_TEXT_SCHEMA,
        abortSignal: abortSignal ?? new AbortController().signal,
        promptId: 'vibe-fill-placeholder',
        role: LlmRole.UTILITY_TOOL,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = result as { text: string };
      return parsed.text.trim();
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

      // Skip truncation for the very last assistant message so we don't
      // cut off questions or options at the end.
      const text = isLastAssistantMessage
        ? (item.text ?? '')
        : (item.text ?? '').slice(0, maxCharsPerMessage);

      return `${role}: ${text}`;
    })
    .join('\n');
}
