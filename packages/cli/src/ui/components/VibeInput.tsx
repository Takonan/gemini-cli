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
import { Command } from '../key/keyMatchers.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { TextInput } from './shared/TextInput.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { formatCommand } from '../key/keybindingUtils.js';

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
  /** If true, bypass review and submit the refined prompt immediately. */
  isYolo?: boolean;
}

// ─── Phase types ─────────────────────────────────────────────────────────────

type Phase =
  | { status: 'loading' }
  | { status: 'asking'; questions: Question[] }
  | { status: 'assembling' }
  | { status: 'reviewing'; refined: string }
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

// ─── Review component ─────────────────────────────────────────────────────────

interface RefinedPromptReviewProps {
  refined: string;
  onSubmit: (final: string) => void;
  onBack: () => void;
  width: number;
}

const RefinedPromptReview: React.FC<RefinedPromptReviewProps> = ({
  refined,
  onSubmit,
  onBack,
  width,
}) => {
  const buffer = useTextBuffer({
    initialText: refined,
    viewport: { width: width - 4, height: 10 },
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Review Refined Prompt:
        </Text>
      </Box>
      <Box borderStyle="round" borderColor="dim" paddingX={1} width={width - 2}>
        <TextInput buffer={buffer} onSubmit={onSubmit} onCancel={onBack} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to confirm • Esc to edit answers</Text>
      </Box>
    </Box>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export const VibeInput: React.FC<VibeInputProps> = ({
  onSubmit,
  onCancel,
  inputWidth,
  vibeGenerator,
  conversationContext = '',
  workspaceContext = '',
  initialDraft = '',
  isYolo: isYoloProp = false,
}) => {
  const keyMatchers = useKeyMatchers();

  // currentDraftRef holds the active draft — starts as initialDraft, updated
  // when the user presses Ctrl+Space while typing in the freeform box.
  const currentDraftRef = useRef(initialDraft);

  // Store answers from AskUserDialog to allow going back from review.
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // generationKey increments to trigger a fresh generation run.
  const [generationKey, setGenerationKey] = useState(0);

  // activeIsClaryMode tracks whether we are currently in clarify (B) mode.
  const [activeIsClaryMode, setActiveIsClaryMode] = useState(
    initialDraft.trim().length > 0,
  );

  const [phase, setPhase] = useState<Phase>({ status: 'loading' });

  // Store clarifying questions for B mode assembly
  const clarifyingQuestionsRef = useRef<ClarifyingQuestion[]>([]);

  // Track if we should bypass review. Initially from prop, can be toggled by Ctrl+Y.
  const isYoloRef = useRef(isYoloProp);

  // Abort on unmount
  const abortRef = useRef<AbortController>(new AbortController());
  useEffect(
    () => () => {
      abortRef.current.abort();
    },
    [],
  );

  /**
   * Core logic to assemble and submit.
   */
  const assembleAndSubmit = useCallback(
    async (
      draft: string,
      newAnswers: Record<string, string>,
      skipReview: boolean,
    ) => {
      setPhase({ status: 'assembling' });

      const questions = clarifyingQuestionsRef.current;
      const questionAnswerPairs = questions
        .map((q, i) => ({
          question: q.question,
          answer: newAnswers[i] ?? '',
        }))
        .filter((qa) => qa.answer.trim());

      try {
        const refined = await vibeGenerator.assembleRefinedPrompt(
          draft,
          questionAnswerPairs,
          abortRef.current.signal,
        );
        if (skipReview) {
          onSubmit(refined);
        } else {
          setPhase({ status: 'reviewing', refined });
        }
      } catch (err: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        if ((err as { name?: string }).name === 'AbortError') return;
        // Fallback: refined is just draft with answers appended
        const fallback =
          draft.trim() +
          (questionAnswerPairs.length
            ? '\n\n' +
              questionAnswerPairs
                .map((qa) => `${qa.question}: ${qa.answer}`)
                .join('\n')
            : '');
        if (skipReview) {
          onSubmit(fallback);
        } else {
          setPhase({ status: 'reviewing', refined: fallback });
        }
      }
    },
    [vibeGenerator, onSubmit],
  );

  // Generate questions whenever generationKey changes (initially 0 = first run).
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;

    const draft = currentDraftRef.current;
    const isClary = draft.trim().length > 0;

    async function generate() {
      // If YOLO and in Clary mode, skip questions and assemble immediately.
      if (isYoloRef.current && isClary) {
        await assembleAndSubmit(draft, {}, true);
        return;
      }

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
   * YOLO vibe mode: bypass review and submit immediately.
   */
  const handleYoloVibe = useCallback(
    (key: Key) => {
      if (keyMatchers[Command.TOGGLE_YOLO](key)) {
        if (activeIsClaryMode && currentDraftRef.current.trim()) {
          isYoloRef.current = true;
          // Trigger assembly immediately with current answers (none if early).
          void assembleAndSubmit(currentDraftRef.current.trim(), answers, true);
          return true;
        }
      }
      return false;
    },
    [activeIsClaryMode, answers, assembleAndSubmit, keyMatchers],
  );

  useKeypress(handleYoloVibe, {
    isActive: phase.status === 'asking' || phase.status === 'loading',
    priority: KeypressPriority.High,
  });

  const handleReviewBack = useCallback(() => {
    isYoloRef.current = false; // Disable YOLO if user went back
    setPhase((p) => {
      if (p.status === 'reviewing') {
        // Return to asking mode
        return {
          status: 'asking',
          questions:
            clarifyingQuestionsRef.current.length > 0
              ? toAskUserQuestions(clarifyingQuestionsRef.current)
              : [],
        };
      }
      return p;
    });
  }, []);

  const handleReviewSubmit = useCallback(
    (final: string) => {
      onSubmit(final);
    },
    [onSubmit],
  );

  /**
   * Called when Ctrl+Space is pressed inside the suggestion dialog.
   * - Without freeform text → regenerate a fresh batch of A-mode suggestions.
   * - With freeform text → treat it as a draft and enter B-mode clarification.
   */
  const handleCtrlSpace = useCallback(
    (freeformText?: string) => {
      isYoloRef.current = false; // Ctrl+Space resets YOLO
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
    async (newAnswers: Record<string, string>) => {
      setAnswers(newAnswers);
      if (!activeIsClaryMode) {
        // A mode: the selected option IS the message
        const answer = newAnswers[0] ?? '';
        if (answer.trim()) {
          onSubmit(answer.trim());
        } else {
          onCancel();
        }
        return;
      }

      // B mode: assemble a refined prompt from draft + answers
      await assembleAndSubmit(
        currentDraftRef.current,
        newAnswers,
        isYoloRef.current,
      );
    },
    [activeIsClaryMode, assembleAndSubmit, onCancel, onSubmit],
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

  if (phase.status === 'reviewing') {
    return (
      <RefinedPromptReview
        refined={phase.refined}
        onSubmit={handleReviewSubmit}
        onBack={handleReviewBack}
        width={inputWidth}
      />
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
        initialAnswers={answers}
        onCancel={handleDialogCancel}
        onCtrlSpace={!activeIsClaryMode ? handleCtrlSpace : undefined}
        onCtrlY={
          activeIsClaryMode ? (curr) => handleDialogSubmit(curr) : undefined
        }
        extraParts={[
          ...(activeIsClaryMode
            ? [`${formatCommand(Command.TOGGLE_YOLO)} to skip questions`]
            : []),
          ...(!activeIsClaryMode ? ['Ctrl+Space to refine or regenerate'] : []),
        ]}
        width={inputWidth - 2}
      />
    </Box>
  );
};
