/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text, useInput } from 'ink';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { ApprovalMode } from '@google/gemini-cli-core';
import type { Config } from '@google/gemini-cli-core';
import type { CommandContext } from '../commands/types.js';
import { InputPrompt } from './InputPrompt.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { StreamingState } from '../types.js';
import type { TextBuffer } from './shared/text-buffer.js';
// Mock VibeInput so tests don't need a live LLM.
vi.mock('./VibeInput.js', () => ({
  VibeInput: ({
    onSubmit,
    onCancel,
  }: {
    onSubmit: (val: string) => void;
    onCancel: () => void;
  }) => {
    // Ink's useInput key object uses boolean flags (key.return, key.escape), not key.name.
    useInput((_input: string, key: { return?: boolean; escape?: boolean }) => {
      if (key.return) {
        onSubmit('vibe suggestion');
      }
      if (key.escape) {
        onCancel();
      }
    });
    return (
      <Box>
        <Text>MOCK_VIBE_INPUT</Text>
      </Box>
    );
  },
}));

// Mock vibeGenerate to avoid actual LLM calls.
vi.mock('../utils/vibeGenerate.js', () => ({
  makeVibeGenerator: () => vi.fn(),
  extractConversationContext: () => 'mock context',
}));

describe('VibeInput Integration', () => {
  let props: Parameters<typeof InputPrompt>[0];
  let mockBuffer: Partial<TextBuffer> & {
    text: string;
    cursor: [number, number];
  };

  beforeEach(() => {
    mockBuffer = {
      text: '',
      lines: [''],
      cursor: [0, 0] as [number, number],
      setText: vi.fn((newText: string) => {
        mockBuffer.text = newText;
      }),
      replaceRangeByOffset: vi.fn(),
      viewportVisualLines: [''],
      allVisualLines: [''],
      visualCursor: [0, 0] as [number, number],
      visualScrollRow: 0,
      handleInput: vi.fn(() => false),
      move: vi.fn(),
      moveToOffset: vi.fn(),
      getOffset: vi.fn(() => 0),
      pastedContent: {},
    };

    props = {
      buffer: mockBuffer as unknown as TextBuffer,
      onSubmit: vi.fn(),
      userMessages: [],
      onClearScreen: vi.fn(),
      config: {
        getProjectRoot: () => '/',
        getTargetDir: () => '/',
        getVimMode: () => false,
        getUseBackgroundColor: () => true,
        getTerminalBackground: () => undefined,
        getBaseLlmClient: () => ({ generateJson: vi.fn() }),
        getWorkspaceContext: () => ({
          getDirectories: () => [],
          onDirectoriesChanged: vi.fn(() => () => {}),
        }),
      } as unknown as Config,
      slashCommands: [],
      commandContext: {
        getCommandFromSuggestion: vi.fn(),
      } as unknown as CommandContext,
      shellModeActive: false,
      setShellModeActive: vi.fn(),
      approvalMode: ApprovalMode.DEFAULT,
      inputWidth: 80,
      suggestionsWidth: 80,
      focus: true,
      setQueueErrorMessage: vi.fn(),
      streamingState: StreamingState.Idle,
      setBannerVisible: vi.fn(),
    };
  });

  it('activates vibe mode, submits suggestion, and clears the buffer', async () => {
    const { stdin, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(<InputPrompt {...props} />);
    await waitUntilReady();

    // 1. Pre-fill the buffer with text typed before opening vibe mode.
    (mockBuffer.setText as ReturnType<typeof vi.fn>)('original text');
    mockBuffer.text = 'original text';

    // 2. Activate vibe mode with Ctrl+Space.
    //    GeminiCLI's KeypressContext parses the kitty keyboard protocol
    //    sequence ESC [ 32 ; 5 u as {name: 'space', ctrl: true}, matching
    //    the TOGGLE_VIBE_MODE binding. (\x00 NUL maps to Ctrl+backtick, not
    //    Ctrl+Space, in GeminiCLI's key parser.)
    await act(async () => {
      stdin.write('\x1b[32;5u');
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('MOCK_VIBE_INPUT');
    });

    // 3. Submit from VibeInput (Enter → mock calls onSubmit('vibe suggestion')).
    await act(async () => {
      stdin.write('\r');
    });

    // 4. Vibe mode closes.
    await waitFor(() => {
      expect(lastFrame()).not.toContain('MOCK_VIBE_INPUT');
    });

    // 5. Buffer must be cleared (via handleSubmitAndClear → buffer.setText('')).
    expect(mockBuffer.setText).toHaveBeenCalledWith('');

    // 6. Parent onSubmit called with the vibe payload.
    expect(props.onSubmit).toHaveBeenCalledWith('vibe suggestion');

    unmount();
  });

  it('closes vibe mode with Escape', async () => {
    const { stdin, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(<InputPrompt {...props} />);
    await waitUntilReady();

    // 1. Activate vibe mode with Ctrl+Space.
    await act(async () => {
      stdin.write('\x1b[32;5u');
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('MOCK_VIBE_INPUT');
    });

    // 2. Press Escape to close vibe mode.
    // Ctrl+Space while vibe mode is active no longer toggles it off — instead
    // it is handled by VibeInput's own handler to regenerate/clarify suggestions.
    await act(async () => {
      stdin.write('\x1b');
    });

    await waitFor(() => {
      expect(lastFrame()).not.toContain('MOCK_VIBE_INPUT');
    });

    unmount();
  });
});
