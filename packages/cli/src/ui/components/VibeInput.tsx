/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text } from 'ink';
import type { VibeGenerator } from '../utils/vibeGenerate.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { KeypressPriority } from '../contexts/KeypressContext.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VibeVariant {
  label: string;
  payload: string;
}

export interface VibeOption {
  variants: VibeVariant[];
  _children: VibeOption[] | null;
  _loading: boolean;
  _fetchPromise: Promise<unknown> | null;
  _error: string | null;
}

export interface VibeInputProps {
  /** Called with the final composed payload — hands back to GeminiCLI's onSubmit */
  onSubmit: (value: string) => void;
  /** Called when user presses Esc at root depth — restores normal input */
  onCancel: () => void;
  /** Available width, passed through from InputPrompt's inputWidth prop */
  inputWidth: number;
  /**
   * Generates suggestion options and refinements.
   */
  vibeGenerator: VibeGenerator;
  /**
   * Last few messages from GeminiCLI's conversation history, collapsed to a
   * plain string. Used to seed context-relevant root suggestions.
   */
  conversationContext?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DEPTH_LABELS = ['intent', 'target', 'action', 'detail'];
const MAX_PAYLOAD_LINE = 66;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getVariant(
  options: VibeOption[],
  index: number,
  vi: number,
): VibeVariant {
  const opt = options[index];
  if (!opt) return { label: '', payload: '' };
  return opt.variants[vi] ?? opt.variants[0] ?? { label: '', payload: '' };
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function getSentences(text: string): string[] {
  if (!text) return [];
  // Split by sentence markers but ignore common abbreviations
  const regex =
    /[^.!?]*?(?:\b(?:Dr|Prof|Mr|Ms|Mrs|Sr|Jr)\.[^.!?]*?)*?[.!?]+(?:\s+|$)|[^.!?]+$/g;
  return text.match(regex) || [text];
}

function getPlaceholders(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  if (!text) return [];
  const regex = /\[[^\]]+\]/g;
  const matches: Array<{ text: string; start: number; end: number }> = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    matches.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

function expandDirection(text: string): string {
  if (text.startsWith('=')) {
    return `Rewrite with a ${text.slice(1)} tone`;
  }
  if (text.startsWith('+')) {
    return `Add more detail about ${text.slice(1)}`;
  }
  if (text.startsWith('-')) {
    return `Remove or reduce ${text.slice(1)}`;
  }
  return text;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface PathStep {
  label: string;
  payload: string;
  nodeIndex: number;
}

type UIStep = 'intent' | 'paragraph' | 'refinement' | 'continuation';

export const VibeInput: React.FC<VibeInputProps> = ({
  onSubmit,
  onCancel,
  inputWidth,
  vibeGenerator,
  conversationContext = '',
}) => {
  const [uiStep, setUiStep] = useState<UIStep>('intent');
  const [rootOptions, setRootOptions] = useState<VibeOption[] | null>(null);
  const [currentOptions, setCurrentOptions] = useState<VibeOption[]>([]);
  const [path, setPath] = useState<PathStep[]>([]);
  const [depth, setDepth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [variantIndices, setVariantIndices] = useState([0, 0, 0, 0]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [waitingForChildren, setWaitingForChildren] = useState(false);
  const [spinFrame, setSpinFrame] = useState(0);
  const [freeMode, setFreeMode] = useState(false);
  const [freeText, setFreeText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // New states for Draft & Refine
  const [currentParagraph, setCurrentParagraph] = useState<string | null>(null);
  const [activeSentenceIdx, setActiveSentenceIdx] = useState(-1);
  const [activePlaceholderIdx, setActivePlaceholderIdx] = useState(-1);
  const [refinements, setRefinements] = useState<Array<{ label: string }>>([]);
  const [continuations, setContinuations] = useState<
    Array<{ label: string; chunk: string }>
  >([]);
  const [refinementLoading, setRefinementLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  // Keep mutable refs for use inside async callbacks
  const pathRef = useRef(path);
  pathRef.current = path;
  const rootOptionsRef = useRef(rootOptions);
  rootOptionsRef.current = rootOptions;

  // Abort controller for in-flight calls
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  // ── Spinner ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!initialLoading && !waitingForChildren && !loading) return;
    const id = setInterval(
      () => setSpinFrame((f) => (f + 1) % SPIN.length),
      80,
    );
    return () => clearInterval(id);
  }, [initialLoading, waitingForChildren, loading]);

  // ── Prefetch ─────────────────────────────────────────────────────────────

  const prefetchChildren = useCallback(
    (options: VibeOption[], optionIndex: number, currentPath: PathStep[]) => {
      const opt = options[optionIndex];
      if (!opt || opt._children || opt._loading || opt._fetchPromise) return;

      opt._loading = true;
      const pathContext = [
        ...currentPath.map((p) => ({ label: p.label })),
        { label: opt.variants[0]?.label ?? '' },
      ];

      const ac = new AbortController();
      abortControllerRef.current = ac;
      opt._fetchPromise = vibeGenerator
        .generateOptions(pathContext, conversationContext, ac.signal)
        .then((children) => {
          opt._children = children;
          opt._loading = false;
          setCurrentOptions((prev) => [...prev]);
        })
        .catch(() => {
          opt._loading = false;
          opt._error = 'Failed to load';
          setCurrentOptions((prev) => [...prev]);
        });
    },
    [vibeGenerator, conversationContext],
  );

  // ── Initial load ─────────────────────────────────────────────────────────

  useEffect(() => {
    const ac = new AbortController();
    abortControllerRef.current = ac;
    vibeGenerator
      .generateOptions([], conversationContext, ac.signal)
      .then((opts) => {
        setRootOptions(opts);
        setCurrentOptions(opts);
        setInitialLoading(false);
        prefetchChildren(opts, 0, []);
      })
      .catch((err) => {
        setInitialLoading(false);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, [vibeGenerator, conversationContext, prefetchChildren]);

  // ── Generation ───────────────────────────────────────────────────────────

  const handleGenerateParagraph = useCallback(
    async (comment = '', isContinuation = false) => {
      const vi = variantIndices[activeIndex] ?? 0;
      const variant = getVariant(currentOptions, activeIndex, vi);
      if (!variant) return;

      let targetSentence = '';
      const sentences = getSentences(currentParagraph || '');
      if (activeSentenceIdx !== -1) {
        targetSentence = sentences[activeSentenceIdx] || '';
      }

      setLoading(true);
      const ac = new AbortController();
      abortControllerRef.current = ac;

      try {
        const text = await vibeGenerator.generateParagraph(
          conversationContext,
          variant.label,
          comment,
          targetSentence,
          currentParagraph || '',
          isContinuation,
          ac.signal,
        );

        if (targetSentence && currentParagraph) {
          // Surgical splice
          const updated = currentParagraph.replace(targetSentence, text);
          setCurrentParagraph(updated);
        } else if (isContinuation && currentParagraph) {
          setCurrentParagraph((prev) => (prev ? `${prev} ${text}` : text));
        } else {
          setCurrentParagraph(text);
        }

        setUiStep('paragraph');
        setActiveSentenceIdx(-1);
        setActivePlaceholderIdx(-1);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setLoadError(err.message);
        }
      } finally {
        setLoading(false);
      }
    },
    [
      activeIndex,
      currentOptions,
      variantIndices,
      activeSentenceIdx,
      currentParagraph,
      vibeGenerator,
      conversationContext,
    ],
  );

  const handleFillPlaceholder = useCallback(
    async (phText: string, roughValue: string) => {
      if (!currentParagraph) return;
      setLoading(true);
      const ac = new AbortController();
      abortControllerRef.current = ac;

      try {
        const refined = await vibeGenerator.fillPlaceholder(
          currentParagraph,
          phText,
          roughValue,
          ac.signal,
        );
        setCurrentParagraph(currentParagraph.replace(phText, refined));
        setActivePlaceholderIdx(-1);
        setUiStep('paragraph');
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setLoadError(err.message);
        }
      } finally {
        setLoading(false);
      }
    },
    [currentParagraph, vibeGenerator],
  );

  // ── Suggestions ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (uiStep !== 'paragraph' || !currentParagraph || loading) return;

    const ac = new AbortController();
    abortControllerRef.current = ac;

    if (activeSentenceIdx !== -1) {
      // Fetch refinements for selected sentence
      const sentences = getSentences(currentParagraph);
      const target = sentences[activeSentenceIdx];
      setRefinementLoading(true);
      vibeGenerator
        .generateRefinements(
          conversationContext,
          currentParagraph,
          target,
          ac.signal,
        )
        .then((res) => {
          setRefinements(res);
          setRefinementLoading(false);
        })
        .catch(() => setRefinementLoading(false));
    } else if (activePlaceholderIdx === -1) {
      // Fetch continuations for end cursor
      const vi = variantIndices[activeIndex] ?? 0;
      const variant = getVariant(currentOptions, activeIndex, vi);
      setRefinementLoading(true);
      vibeGenerator
        .generateContinuations(
          conversationContext,
          currentParagraph,
          variant?.label || '',
          '',
          ac.signal,
        )
        .then((res) => {
          setContinuations(res);
          setRefinementLoading(false);
        })
        .catch(() => setRefinementLoading(false));
    }
  }, [
    uiStep,
    currentParagraph,
    activeSentenceIdx,
    activePlaceholderIdx,
    vibeGenerator,
    conversationContext,
    loading,
    activeIndex,
    currentOptions,
    variantIndices,
  ]);

  // ── Keyboard ─────────────────────────────────────────────────────────────

  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(0);

  const handleKeyPress = useCallback(
    (key: Key) => {
      if (initialLoading || loadError || loading) return false;

      // ── Free text mode / Direction mode ──
      if (freeMode) {
        const suggestions =
          activeSentenceIdx !== -1
            ? refinements
            : activePlaceholderIdx === -1
              ? continuations
              : [];
        const query = freeText.trim().toLowerCase();
        const matches = query
          ? suggestions.filter((s) => s.label.toLowerCase().includes(query))
          : suggestions;

        if (key.name === 'return' || key.sequence === '\r') {
          const rawComment =
            matches.length > 0 && activeSuggestionIdx < matches.length
              ? matches[activeSuggestionIdx].label
              : freeText.trim();

          setFreeMode(false);
          setFreeText('');
          setActiveSuggestionIdx(0);

          if (!rawComment) return true;

          // Placeholder fill: [name]=rough value
          const phs = getPlaceholders(currentParagraph || '');
          const ph =
            activePlaceholderIdx !== -1 ? phs[activePlaceholderIdx] : null;
          if (ph && rawComment.includes('=')) {
            const value = rawComment.split('=')[1] || '';
            void handleFillPlaceholder(ph.text, value);
            return true;
          }

          const comment = expandDirection(rawComment);
          const isActuallyContinuing =
            uiStep === 'paragraph' &&
            activeSentenceIdx === -1 &&
            activePlaceholderIdx === -1;

          // If it was a continuation match, we might want to use the chunk directly
          const match = matches.find((m) => m.label === rawComment);
          if (isActuallyContinuing && match && 'chunk' in match) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const chunk = (match as { chunk: string }).chunk;
            setCurrentParagraph((prev: string | null) =>
              prev ? `${prev} ${chunk}` : chunk,
            );
          } else {
            void handleGenerateParagraph(comment, isActuallyContinuing);
          }
          return true;
        } else if (key.name === 'tab') {
          if (matches.length > 0) {
            setFreeText(matches[activeSuggestionIdx].label);
          }
          return true;
        } else if (key.name === 'up') {
          setActiveSuggestionIdx((prev) =>
            matches.length > 0
              ? (prev - 1 + matches.length) % matches.length
              : 0,
          );
          return true;
        } else if (key.name === 'down') {
          setActiveSuggestionIdx((prev) =>
            matches.length > 0 ? (prev + 1) % matches.length : 0,
          );
          return true;
        } else if (key.name === 'escape') {
          setFreeMode(false);
          setFreeText('');
          setActiveSuggestionIdx(0);
          return true;
        } else if (key.name === 'backspace' || key.name === 'delete') {
          setFreeText((t) => t.slice(0, -1));
          setActiveSuggestionIdx(0);
          return true;
        } else if (
          key.sequence &&
          !key.ctrl &&
          !key.cmd &&
          key.sequence.length === 1
        ) {
          setFreeText((t) => t + key.sequence);
          setActiveSuggestionIdx(0);
          return true;
        }
        return true; // Consume other keys in freeMode
      }

      if (waitingForChildren) return false;

      // ── Paragraph Mode Navigation ──
      if (uiStep === 'paragraph') {
        const sentences = getSentences(currentParagraph || '');
        const placeholders = getPlaceholders(currentParagraph || '');

        if (key.name === 'left' || key.sequence === 'h') {
          setActivePlaceholderIdx(-1);
          setActiveSentenceIdx((prev) =>
            prev === -1 ? sentences.length - 1 : Math.max(0, prev - 1),
          );
          return true;
        } else if (key.name === 'right' || key.sequence === 'l') {
          setActivePlaceholderIdx(-1);
          setActiveSentenceIdx((prev) =>
            prev >= sentences.length - 1 ? -1 : prev + 1,
          );
          return true;
        } else if (key.sequence === '[') {
          setActiveSentenceIdx(-1);
          if (placeholders.length > 0) {
            setActivePlaceholderIdx((prev) => (prev + 1) % placeholders.length);
          }
          return true;
        } else if (key.sequence === '/') {
          setFreeMode(true);
          const ph =
            activePlaceholderIdx !== -1
              ? placeholders[activePlaceholderIdx]
              : null;
          setFreeText(ph ? `${ph.text}=` : '');
          return true;
        } else if (key.name === 'return' || key.sequence === '\r') {
          if (currentParagraph) onSubmit(currentParagraph);
          return true;
        } else if (key.name === 'escape') {
          if (activeSentenceIdx !== -1 || activePlaceholderIdx !== -1) {
            setActiveSentenceIdx(-1);
            setActivePlaceholderIdx(-1);
          } else {
            setUiStep('intent');
            setCurrentParagraph(null);
          }
          return true;
        }
        return true;
      }

      // ── Intent Mode (Original Tree) ──
      // Number jump
      const num = parseInt(key.sequence, 10);
      if (!isNaN(num) && num >= 1 && num <= currentOptions.length) {
        const newIdx = num - 1;
        setActiveIndex(newIdx);
        prefetchChildren(currentOptions, newIdx, path);
        return true;
      }

      if (key.name === 'up' || key.sequence === 'k') {
        const newIdx = Math.max(0, activeIndex - 1);
        setActiveIndex(newIdx);
        prefetchChildren(currentOptions, newIdx, path);
        return true;
      } else if (key.name === 'down' || key.sequence === 'j') {
        const newIdx = Math.min(currentOptions.length - 1, activeIndex + 1);
        setActiveIndex(newIdx);
        prefetchChildren(currentOptions, newIdx, path);
        return true;
      } else if (key.name === 'left' || key.sequence === 'h') {
        const opt = currentOptions[activeIndex];
        if (opt) {
          const total = opt.variants.length;
          setVariantIndices((vi) => {
            const next = [...vi];
            next[activeIndex] = ((vi[activeIndex] ?? 0) - 1 + total) % total;
            return next;
          });
        }
        return true;
      } else if (key.name === 'right' || key.sequence === 'l') {
        const opt = currentOptions[activeIndex];
        if (opt) {
          const total = opt.variants.length;
          setVariantIndices((vi) => {
            const next = [...vi];
            next[activeIndex] = ((vi[activeIndex] ?? 0) + 1) % total;
            return next;
          });
        }
        return true;
      } else if (key.name === 'tab') {
        // Confirm block → advance depth
        const vi = variantIndices[activeIndex] ?? 0;
        const variant = getVariant(currentOptions, activeIndex, vi);
        const opt = currentOptions[activeIndex];
        if (!opt) return true;

        const newPath: PathStep[] = [
          ...path,
          {
            label: variant.label,
            payload: variant.payload,
            nodeIndex: activeIndex,
          },
        ];
        setPath(newPath);
        setDepth((d) => d + 1);

        if (opt._children?.length) {
          setCurrentOptions(opt._children);
          setActiveIndex(0);
          setVariantIndices([0, 0, 0, 0]);
          prefetchChildren(opt._children, 0, newPath);
        } else {
          setWaitingForChildren(true);
          const ac = new AbortController();
          abortControllerRef.current = ac;
          void vibeGenerator
            .generateOptions(
              newPath.map((p) => ({ label: p.label })),
              conversationContext,
              ac.signal,
            )
            .then((children) => {
              opt._children = children;
              setWaitingForChildren(false);
              setCurrentOptions(children);
              setActiveIndex(0);
              setVariantIndices([0, 0, 0, 0]);
              if (children.length) prefetchChildren(children, 0, newPath);
            })
            .catch(() => {
              setWaitingForChildren(false);
              setPath(pathRef.current.slice(0, -1));
              setDepth((d) => Math.max(0, d - 1));
            });
        }
        return true;
      } else if (key.name === 'return' || key.sequence === '\r') {
        // Intent confirmed -> Generate Draft
        void handleGenerateParagraph();
        return true;
      } else if (key.sequence === '/') {
        setFreeMode(true);
        setFreeText('');
        return true;
      } else if (key.name === 'escape') {
        if (path.length > 0) {
          const newPath = path.slice(0, -1);
          setPath(newPath);
          setDepth((d) => Math.max(0, d - 1));

          let opts = rootOptionsRef.current ?? [];
          for (const step of newPath) {
            opts = opts[step.nodeIndex]?._children ?? opts;
          }
          setCurrentOptions(opts);
          setActiveIndex(0);
          setVariantIndices([0, 0, 0, 0]);
        } else {
          onCancel();
        }
        return true;
      }
      return false;
    },
    [
      initialLoading,
      loadError,
      loading,
      freeMode,
      activeSentenceIdx,
      refinements,
      activePlaceholderIdx,
      continuations,
      freeText,
      activeSuggestionIdx,
      currentParagraph,
      uiStep,
      handleFillPlaceholder,
      handleGenerateParagraph,
      waitingForChildren,
      currentOptions,
      activeIndex,
      prefetchChildren,
      path,
      variantIndices,
      vibeGenerator,
      conversationContext,
      onCancel,
      onSubmit,
    ],
  );

  useKeypress(handleKeyPress, {
    isActive: true,
    priority: KeypressPriority.High,
  });

  // ── Render ────────────────────────────────────────────────────────────────

  const maxWidth = Math.min(inputWidth - 4, 76);

  if (loadError) {
    return (
      <Box>
        <Text color="yellow">✗ vibetype: </Text>
        <Text dimColor>{loadError}</Text>
      </Box>
    );
  }

  if (initialLoading) {
    return (
      <Box>
        <Text color="magenta">{SPIN[spinFrame]} </Text>
        <Text dimColor>generating suggestions...</Text>
      </Box>
    );
  }

  if (freeMode) {
    const suggestions =
      activeSentenceIdx !== -1
        ? refinements
        : activePlaceholderIdx === -1
          ? continuations
          : [];
    const query = freeText.trim().toLowerCase();
    const matches = query
      ? suggestions.filter((s) => s.label.toLowerCase().includes(query))
      : suggestions;

    return (
      <Box flexDirection="column">
        <Text dimColor>Direction / Type your prompt:</Text>
        <Box>
          <Text color="magenta">❯ </Text>
          <Text color="white">{freeText}</Text>
          <Text>█</Text>
        </Box>

        {refinementLoading && matches.length === 0 && (
          <Box marginTop={1}>
            <Text color="magenta">{SPIN[spinFrame]} </Text>
            <Text dimColor>fetching suggestions...</Text>
          </Box>
        )}

        {matches.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Suggestions (Tab to select, ↑/↓ navigate):</Text>
            {matches.slice(0, 5).map((m, i) => (
              <Box key={i}>
                <Text color={i === activeSuggestionIdx ? 'cyan' : undefined}>
                  {i === activeSuggestionIdx ? '▸' : ' '}
                </Text>
                <Text
                  color={i === activeSuggestionIdx ? 'white' : 'gray'}
                  bold={i === activeSuggestionIdx}
                >
                  {' '}
                  {m.label}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Enter confirm Esc back</Text>
        </Box>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box>
        <Text color="magenta">{SPIN[spinFrame]} </Text>
        <Text dimColor>generating draft...</Text>
      </Box>
    );
  }

  // ── Paragraph Render ──
  if (uiStep === 'paragraph' && currentParagraph) {
    const sentences = getSentences(currentParagraph);
    const placeholders = getPlaceholders(currentParagraph);
    const activePH =
      activePlaceholderIdx !== -1 ? placeholders[activePlaceholderIdx] : null;

    return (
      <Box flexDirection="column" width={maxWidth}>
        <Box marginBottom={1}>
          <Text dimColor>Drafting Mode: </Text>
          <Text color="magenta">
            {activePH
              ? 'placeholder selected'
              : activeSentenceIdx === -1
                ? 'continuing'
                : 'refining sentence'}
          </Text>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Text>
            {sentences.map((s, i) => {
              const isSelected = i === activeSentenceIdx;
              if (isSelected) {
                return (
                  <Text key={i} backgroundColor="magenta" color="white">
                    {s}
                  </Text>
                );
              }
              // Check if sentence contains selected placeholder
              if (activePH) {
                const sStart = currentParagraph.indexOf(s);
                const sEnd = sStart + s.length;
                if (activePH.start >= sStart && activePH.end <= sEnd) {
                  const before = currentParagraph.slice(sStart, activePH.start);
                  const after = currentParagraph.slice(activePH.end, sEnd);
                  return (
                    <Text key={i} color="white">
                      {before}
                      <Text backgroundColor="yellow" color="black">
                        {activePH.text}
                      </Text>
                      {after}
                    </Text>
                  );
                }
              }
              return (
                <Text key={i} color="white" dimColor={activeSentenceIdx !== -1}>
                  {s}
                </Text>
              );
            })}
            {activeSentenceIdx === -1 && activePlaceholderIdx === -1 && (
              <Text color="cyan">▌</Text>
            )}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            h/l nav sentences [ nav placeholders / refine Enter send Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Intent Render ──
  const activeVariant = getVariant(
    currentOptions,
    activeIndex,
    variantIndices[activeIndex] ?? 0,
  );

  return (
    <Box flexDirection="column" width={maxWidth}>
      {/* Breadcrumbs */}
      {path.length > 0 && (
        <Box flexWrap="wrap" marginBottom={1}>
          {path.map((step, i) => (
            <React.Fragment key={i}>
              <Text color="magenta">{step.label}</Text>
              <Text dimColor> → </Text>
            </React.Fragment>
          ))}
        </Box>
      )}

      {/* Depth dots */}
      <Box marginBottom={1}>
        {Array.from({ length: depth + 1 }).map((_, i) => (
          <Text key={i} color={i < depth ? 'magenta' : 'cyan'}>
            {i < depth ? '● ' : '◉ '}
          </Text>
        ))}
        <Text dimColor>{DEPTH_LABELS[depth] ?? `depth ${depth}`}</Text>
      </Box>

      {waitingForChildren ? (
        <Box>
          <Text color="magenta">{SPIN[spinFrame]} </Text>
          <Text dimColor>generating options...</Text>
        </Box>
      ) : (
        <>
          {/* Payload preview */}
          {activeVariant.payload && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>┄┄ will draft →</Text>
              {wrapText(activeVariant.payload, MAX_PAYLOAD_LINE).map(
                (line, i) => (
                  <Text key={i} dimColor>
                    ┄┄ {line}
                  </Text>
                ),
              )}
            </Box>
          )}

          {/* Option list */}
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            {currentOptions.map((opt, i) => {
              const vi = variantIndices[i] ?? 0;
              const variant = getVariant(currentOptions, i, vi);
              const isActive = i === activeIndex;
              const totalV = opt.variants.length;

              return (
                <Box key={i}>
                  <Text color={isActive ? 'cyan' : undefined}>
                    {isActive ? '▸' : ' '}
                  </Text>
                  <Text color={isActive ? 'cyan' : 'gray'}> {i + 1} </Text>
                  <Text bold={isActive} color={isActive ? 'white' : 'gray'}>
                    {variant.label}
                  </Text>
                  {totalV > 1 && (
                    <Text dimColor>
                      {' '}
                      ◀▶ {vi + 1}/{totalV}
                    </Text>
                  )}
                  {isActive && opt._loading && (
                    <Text dimColor> {SPIN[spinFrame]}</Text>
                  )}
                </Box>
              );
            })}
          </Box>

          {/* Controls hint */}
          <Box marginTop={1} flexWrap="wrap">
            <Text dimColor>
              j/k nav h/l variants Tab confirm Enter draft / type Esc back
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};
