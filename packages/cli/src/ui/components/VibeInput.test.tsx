/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mocked } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { VibeInput } from './VibeInput.js';
import type { VibeGenerator } from '../utils/vibeGenerate.js';

describe('VibeInput', () => {
  let mockVibeGenerator: Mocked<VibeGenerator>;
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockVibeGenerator = {
      generateNextPromptOptions: vi.fn(),
      generateClarifyingQuestions: vi.fn(),
      assembleRefinedPrompt: vi.fn(),
    } as unknown as Mocked<VibeGenerator>;
  });

  it('Mode B: generates questions, assembles, and shows review', async () => {
    const questions = [
      {
        question: 'What is the scope?',
        header: 'Scope',
        options: [
          { label: 'Frontend', description: '' },
          { label: 'Backend', description: '' },
        ],
      },
    ];
    mockVibeGenerator.generateClarifyingQuestions.mockResolvedValue(questions);
    mockVibeGenerator.assembleRefinedPrompt.mockResolvedValue(
      'Refined: My Draft with Frontend scope',
    );

    const { stdin, lastFrame, waitUntilReady } = await renderWithProviders(
      <VibeInput
        onSubmit={onSubmit}
        onCancel={onCancel}
        inputWidth={80}
        vibeGenerator={mockVibeGenerator}
        initialDraft="My Draft"
      />,
    );

    await waitUntilReady();

    // Should show the question
    await waitFor(() => {
      expect(lastFrame()).toContain('What is the scope?');
    });

    // Select Frontend (first option) and Enter
    await act(async () => {
      stdin.write('\r');
    });

    // Should show review phase
    await waitFor(() => {
      expect(lastFrame()).toContain('Review Refined Prompt:');
      expect(lastFrame()).toContain('Refined: My Draft with Frontend scope');
    });

    // Confirm review
    await act(async () => {
      stdin.write('\r');
    });

    expect(onSubmit).toHaveBeenCalledWith(
      'Refined: My Draft with Frontend scope',
    );
  });

  it('Mode B: ESC in review goes back to questions', async () => {
    const questions = [
      {
        question: 'What is the scope?',
        header: 'Scope',
        options: [
          { label: 'Frontend', description: '' },
          { label: 'Backend', description: '' },
        ],
      },
    ];
    mockVibeGenerator.generateClarifyingQuestions.mockResolvedValue(questions);
    mockVibeGenerator.assembleRefinedPrompt.mockResolvedValue(
      'Refined: My Draft',
    );

    const { stdin, lastFrame, waitUntilReady } = await renderWithProviders(
      <VibeInput
        onSubmit={onSubmit}
        onCancel={onCancel}
        inputWidth={80}
        vibeGenerator={mockVibeGenerator}
        initialDraft="My Draft"
      />,
    );

    await waitUntilReady();

    // Answer question
    await act(async () => {
      stdin.write('\r');
    });

    // Wait for review
    await waitFor(() => {
      expect(lastFrame()).toContain('Review Refined Prompt:');
    });

    // Press ESC to go back
    await act(async () => {
      stdin.write('\x1b');
    });

    // Should be back at the question
    await waitFor(() => {
      expect(lastFrame()).toContain('What is the scope?');
    });
  });

  it('YOLO vibe mode: bypasses questions and review but performs refinement', async () => {
    mockVibeGenerator.generateClarifyingQuestions.mockResolvedValue([]);
    mockVibeGenerator.assembleRefinedPrompt.mockResolvedValue(
      'Refined YOLO Prompt',
    );

    const { stdin, waitUntilReady } = await renderWithProviders(
      <VibeInput
        onSubmit={onSubmit}
        onCancel={onCancel}
        inputWidth={80}
        vibeGenerator={mockVibeGenerator}
        initialDraft="My Draft"
      />,
    );

    await waitUntilReady();

    // Press Ctrl+Y (YOLO)
    await act(async () => {
      stdin.write('\x19'); // Ctrl+Y
    });

    await waitFor(() => {
      expect(mockVibeGenerator.assembleRefinedPrompt).toHaveBeenCalled();
      expect(onSubmit).toHaveBeenCalledWith('Refined YOLO Prompt');
    });
  });
});
