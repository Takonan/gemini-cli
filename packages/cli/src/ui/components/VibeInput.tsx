/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

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
   * Generates suggestion options for the tree.
   * pathContext: the chain of labels selected so far (empty = root).
   * convContext: the seeded conversation summary for relevance.
   */
  generateOptions: (
    pathContext: Array<{ label: string }>,
    convContext: string,
    abortSignal: AbortSignal,
  ) => Promise<VibeOption[]>;
  /**
   * Last few messages from GeminiCLI's conversation history, collapsed to a
   * plain string. Used to seed context-relevant root suggestions.
   * See the InputPrompt wiring for how to derive this from uiState.history.
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

// ─── Component ───────────────────────────────────────────────────────────────

interface PathStep {
  label: string;
  payload: string;
  nodeIndex: number;
}

export const VibeInput: React.FC<VibeInputProps> = ({
  onSubmit,
  onCancel,
  inputWidth,
  generateOptions,
  conversationContext = '',
}) => {
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

  // Keep mutable refs for use inside async callbacks where stale closure
  // would otherwise read outdated state.
  const pathRef = useRef(path);
  pathRef.current = path;
  const rootOptionsRef = useRef(rootOptions);
  rootOptionsRef.current = rootOptions;

  // Abort controller for in-flight generateOptions calls.
  // Cancelled on unmount and on each new prefetch that replaces a prior one.
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
      abortControllerRef.current?.abort();
    }, []);

  // ── Spinner ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!initialLoading && !waitingForChildren) return;
    const id = setInterval(
      () => setSpinFrame((f) => (f + 1) % SPIN.length),
      80,
    );
    return () => clearInterval(id);
  }, [initialLoading, waitingForChildren]);

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
      opt._fetchPromise = generateOptions(
        pathContext,
        conversationContext,
        ac.signal,
      )
        .then((children) => {
          opt._children = children;
          opt._loading = false;
          // Nudge a re-render to update the loading indicator.
          setCurrentOptions((prev) => [...prev]);
        })
        .catch(() => {
          opt._loading = false;
          opt._error = 'Failed to load';
          setCurrentOptions((prev) => [...prev]);
        });
    },
    [generateOptions, conversationContext],
  );

  // ── Initial load ─────────────────────────────────────────────────────────

  useEffect(() => {
    const seedContext = conversationContext
      ? [{ label: conversationContext }]
      : [];
    const ac = new AbortController();
    abortControllerRef.current = ac;
    generateOptions(seedContext, conversationContext, ac.signal)
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
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keyboard ─────────────────────────────────────────────────────────────

  useInput((input, key) => {
    if (initialLoading || loadError) return;

    // ── Free text mode ──
    if (freeMode) {
      if (key.return) {
        const trimmed = freeText.trim();
        if (trimmed) onSubmit(trimmed);
      } else if (key.escape) {
        setFreeMode(false);
        setFreeText('');
      } else if (key.backspace || key.delete) {
        setFreeText((t) => t.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input.length === 1) {
        setFreeText((t) => t + input);
      }
      return;
    }

    if (waitingForChildren) return;

    // Number jump
    const num = parseInt(input, 10);
    if (num >= 1 && num <= currentOptions.length) {
      const newIdx = num - 1;
      setActiveIndex(newIdx);
      prefetchChildren(currentOptions, newIdx, path);
      return;
    }

    if (key.upArrow || input === 'k') {
      const newIdx = Math.max(0, activeIndex - 1);
      setActiveIndex(newIdx);
      prefetchChildren(currentOptions, newIdx, path);
    } else if (key.downArrow || input === 'j') {
      const newIdx = Math.min(currentOptions.length - 1, activeIndex + 1);
      setActiveIndex(newIdx);
      prefetchChildren(currentOptions, newIdx, path);
    } else if (key.leftArrow || input === 'h') {
      const opt = currentOptions[activeIndex];
      if (opt) {
        const total = opt.variants.length;
        setVariantIndices((vi) => {
          const next = [...vi];
          next[activeIndex] = ((vi[activeIndex] ?? 0) - 1 + total) % total;
          return next;
        });
      }
    } else if (key.rightArrow || input === 'l') {
      const opt = currentOptions[activeIndex];
      if (opt) {
        const total = opt.variants.length;
        setVariantIndices((vi) => {
          const next = [...vi];
          next[activeIndex] = ((vi[activeIndex] ?? 0) + 1) % total;
          return next;
        });
      }
    } else if (key.tab) {
      // Confirm block → advance depth
      const vi = variantIndices[activeIndex] ?? 0;
      const variant = getVariant(currentOptions, activeIndex, vi);
      const opt = currentOptions[activeIndex];
      if (!opt) return;

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
        const settle =
          opt._fetchPromise ??
          (() => {
            const ac = new AbortController();
            abortControllerRef.current = ac;
            return generateOptions(
              newPath.map((p) => ({ label: p.label })),
              conversationContext,
              ac.signal,
            );
          })().then((children) => {
            opt._children = children;
          });

        settle
          .then(() => {
            setWaitingForChildren(false);
            const children = opt._children ?? [];
            setCurrentOptions(children);
            setActiveIndex(0);
            setVariantIndices([0, 0, 0, 0]);
            if (children.length) prefetchChildren(children, 0, newPath);
          })
          .catch(() => {
            // Roll back
            setWaitingForChildren(false);
            setPath(pathRef.current.slice(0, -1));
            setDepth((d) => Math.max(0, d - 1));
          });
      }
    } else if (key.return) {
      // Send immediately (skip remaining depths)
      const vi = variantIndices[activeIndex] ?? 0;
      const variant = getVariant(currentOptions, activeIndex, vi);
      onSubmit(variant.payload);
    } else if (input === '/') {
      setFreeMode(true);
      setFreeText('');
    } else if (key.escape) {
      if (path.length > 0) {
        // Navigate back one depth
        const newPath = path.slice(0, -1);
        setPath(newPath);
        setDepth((d) => Math.max(0, d - 1));

        // Walk the root tree to find the parent's option list
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
    }
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
    return (
      <Box flexDirection="column">
        <Text dimColor>Type your prompt:</Text>
        <Box>
          <Text color="magenta">❯ </Text>
          <Text color="white">{freeText}</Text>
          <Text>█</Text>
        </Box>
        <Text dimColor>Enter send Esc back to suggestions</Text>
      </Box>
    );
  }

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
              <Text dimColor>┄┄ will send →</Text>
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
              j/k nav h/l variants Tab confirm Enter send / type Esc back
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};
