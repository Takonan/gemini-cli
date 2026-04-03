/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text } from 'ink';
import type {
  VibeGenerator,
  ClarifyingQuestion,
} from '../utils/vibeGenerate.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { KeypressPriority } from '../contexts/KeypressContext.js';
import { AskUserDialog } from './AskUserDialog.js';
import { QuestionType, type Question } from '@google/gemini-cli-core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VibeInputProps {
  /** Called with the final composed prompt — hands back to GeminiCLI's onSubmit */
  onSubmit: (value: string) => void;
  /** Called when user presses Esc — restores normal input */
  onCancel: () => void;
  /** Available width */
  inputWidth: number;
  /** Generator for prompt suggestions and clarifying questions */
  vibeGenerator: VibeGenerator;
  /** Recent conversation context for seeding suggestions */
  conversationContext?: string;
  /** Brief workspace state summary */
  workspaceContext?: string;
  /**
   * Text the user had already typed when they pressed Ctrl+Space.
   * Empty or undefined → A mode: suggest next prompts.
   * Non-empty → B mode: generate clarifying questions to refine the draft.
   */
  initialDraft?: string;
}

// ─── Phase types ─────────────────────────────────────────────────────────────

type Phase =
  | { status: 'loading' }
  | { status: 'asking'; questions: Question[] }
  | { status: 'assembling' }
  | { status: 'error'; message: string };

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const Spinner: React.FC<{ label: string }> = ({ label }) => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <Box>
      <Text color="magenta">{SPIN[frame]} </Text>
      <Text dimColor>{label}</Text>
    </Box>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert ClarifyingQuestion[] (from vibeGenerate) into Question[] (for AskUserDialog).
 */
function toAskUserQuestions(clarifying: ClarifyingQuestion[]): Question[] {
  return clarifying.map((q) => ({
    question: q.question,
    header: q.header,
    type: QuestionType.CHOICE,
    options: q.options.map((opt) => ({
      label: opt.label,
      description: opt.description,
    })),
    multiSelect: false,
    placeholder: 'Describe your preference...',
  }));
}

/**
 * Convert next-prompt options into a single AskUserDialog question.
 */
function toNextPromptQuestion(
  options: Array<{ label: string; description: string }>,
): Question[] {
  return [
    {
      question: 'What would you like to do next?',
      header: 'Next',
      type: QuestionType.CHOICE,
      options: options.map((opt) => ({
        label: opt.label,
        description: opt.description,
      })),
      multiSelect: false,
      placeholder: 'Describe what you want to do...',
    },
  ];
}

// ─── Main component ───────────────────────────────────────────────────────────

export const VibeInput: React.FC<VibeInputProps> = ({
  onSubmit,
  onCancel,
  inputWidth,
  vibeGenerator,
  conversationContext = '',
  workspaceContext = '',
  initialDraft = '',
}) => {
  // currentDraftRef holds the active draft — starts as initialDraft, updated
  // when the user presses Ctrl+Space while typing in the freeform box.
  const currentDraftRef = useRef(initialDraft);

  // generationKey increments to trigger a fresh generation run.
  const [generationKey, setGenerationKey] = useState(0);

  // activeIsClaryMode tracks whether we are currently in clarify (B) mode.
  const [activeIsClaryMode, setActiveIsClaryMode] = useState(
    initialDraft.trim().length > 0,
  );

  const [phase, setPhase] = useState<Phase>({ status: 'loading' });

  // Store clarifying questions for B mode assembly
  const clarifyingQuestionsRef = useRef<ClarifyingQuestion[]>([]);

  // Abort on unmount
  const abortRef = useRef<AbortController>(new AbortController());
  useEffect(
    () => () => {
      abortRef.current.abort();
    },
    [],
  );

  // Generate questions whenever generationKey changes (initially 0 = first run).
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;

    const draft = currentDraftRef.current;
    const isClary = draft.trim().length > 0;

    async function generate() {
      if (isClary) {
        const questions = await vibeGenerator.generateClarifyingQuestions(
          draft,
          conversationContext,
          workspaceContext,
          ac.signal,
        );
        clarifyingQuestionsRef.current = questions;
        setPhase({
          status: 'asking',
          questions: toAskUserQuestions(questions),
        });
      } else {
        const options = await vibeGenerator.generateNextPromptOptions(
          conversationContext,
          workspaceContext,
          ac.signal,
        );
        setPhase({
          status: 'asking',
          questions: toNextPromptQuestion(options),
        });
      }
    }

    generate().catch((err: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      if ((err as { name?: string }).name === 'AbortError') return;
      setPhase({ status: 'error', message: 'Failed to generate suggestions.' });
    });

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationKey]);

  const handleCancel = useCallback(
    (key: Key) => {
      if (key.name === 'escape') {
        onCancel();
        return true;
      }
      return false;
    },
    [onCancel],
  );

  useKeypress(handleCancel, {
    isActive:
      phase.status === 'loading' ||
      phase.status === 'assembling' ||
      phase.status === 'error',
    priority: KeypressPriority.High,
  });

  /**
   * Called when Ctrl+Space is pressed inside the suggestion dialog.
   * - Without freeform text → regenerate a fresh batch of A-mode suggestions.
   * - With freeform text → treat it as a draft and enter B-mode clarification.
   */
  const handleCtrlSpace = useCallback(
    (freeformText?: string) => {
      if (freeformText && freeformText.trim()) {
        // Switch to B-mode clarification for the typed freeform text
        currentDraftRef.current = freeformText;
        setActiveIsClaryMode(true);
      } else {
        // Regenerate A-mode suggestions (reset draft)
        currentDraftRef.current = initialDraft;
        setActiveIsClaryMode(initialDraft.trim().length > 0);
      }
      setPhase({ status: 'loading' });
      setGenerationKey((k) => k + 1);
    },
    [initialDraft],
  );

  const handleDialogSubmit = useCallback(
    async (answers: Record<string, string>) => {
      if (!activeIsClaryMode) {
        // A mode: the selected option IS the message
        const answer = answers[0] ?? '';
        if (answer.trim()) {
          onSubmit(answer.trim());
        } else {
          onCancel();
        }
        return;
      }

      // B mode: assemble a refined prompt from draft + answers
      setPhase({ status: 'assembling' });

      const draft = currentDraftRef.current;
      const questions = clarifyingQuestionsRef.current;
      const questionAnswerPairs = questions
        .map((q, i) => ({
          question: q.question,
          answer: answers[i] ?? '',
        }))
        .filter((qa) => qa.answer.trim());

      try {
        const refined = await vibeGenerator.assembleRefinedPrompt(
          draft,
          questionAnswerPairs,
          abortRef.current.signal,
        );
        onSubmit(refined);
      } catch (err: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        if ((err as { name?: string }).name === 'AbortError') return;
        // Fallback: submit the draft with answers appended
        const fallback =
          draft.trim() +
          (questionAnswerPairs.length
            ? '\n\n' +
              questionAnswerPairs
                .map((qa) => `${qa.question}: ${qa.answer}`)
                .join('\n')
            : '');
        onSubmit(fallback);
      }
    },
    [activeIsClaryMode, vibeGenerator, onSubmit, onCancel],
  );

  const handleDialogCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  if (phase.status === 'loading') {
    return (
      <Box paddingLeft={1}>
        <Spinner
          label={
            activeIsClaryMode
              ? 'generating clarifying questions...'
              : 'generating suggestions...'
          }
        />
      </Box>
    );
  }

  if (phase.status === 'assembling') {
    return (
      <Box paddingLeft={1}>
        <Spinner label="assembling your prompt..." />
      </Box>
    );
  }

  if (phase.status === 'error') {
    return (
      <Box paddingLeft={1}>
        <Text color="red">{phase.message} </Text>
        <Text dimColor>Press Esc to dismiss.</Text>
      </Box>
    );
  }

  // phase.status === 'asking'
  return (
    <Box paddingX={1}>
      <AskUserDialog
        questions={phase.questions}
        onSubmit={handleDialogSubmit}
        onCancel={handleDialogCancel}
        onCtrlSpace={!activeIsClaryMode ? handleCtrlSpace : undefined}
        extraParts={
          !activeIsClaryMode
            ? ['Ctrl+Space to refine or regenerate']
            : undefined
        }
        width={inputWidth - 2}
      />
    </Box>
  );
};
