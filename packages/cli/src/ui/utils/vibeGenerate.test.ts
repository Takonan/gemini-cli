/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extractConversationContext } from './vibeGenerate.js';

describe('vibeGenerate', () => {
  describe('extractConversationContext', () => {
    it('extracts user and gemini messages', () => {
      const history = [
        { type: 'user', text: 'Hello' },
        { type: 'gemini', text: 'Hi there!' },
      ];
      const result = extractConversationContext(history);
      expect(result).toBe('user: Hello\nassistant: Hi there!');
    });

    it('extracts gemini_content and user_shell messages', () => {
      const history = [
        { type: 'user_shell', text: 'ls' },
        { type: 'gemini_content', text: 'file1.txt\nfile2.txt' },
      ];
      const result = extractConversationContext(history);
      expect(result).toBe('user: ls\nassistant: file1.txt\nfile2.txt');
    });

    it('truncates older messages but keeps the last assistant message intact', () => {
      const history = [
        { type: 'user', text: 'A'.repeat(500) },
        { type: 'gemini', text: 'B'.repeat(500) },
      ];
      const result = extractConversationContext(history, 6, 10);
      // Last message (assistant) is NOT truncated
      expect(result).toBe(
        `user: ${'A'.repeat(10)}\nassistant: ${'B'.repeat(500)}`,
      );
    });

    it('filters out non-conversation items', () => {
      const history = [
        { type: 'info', text: 'System starting...' },
        { type: 'user', text: 'Hello' },
        { type: 'thinking', text: 'Thinking...' },
        { type: 'gemini', text: 'Hi' },
      ];
      const result = extractConversationContext(history);
      expect(result).toBe('user: Hello\nassistant: Hi');
    });

    it('limits the number of messages', () => {
      const history = [
        { type: 'user', text: '1' },
        { type: 'gemini', text: '2' },
        { type: 'user', text: '3' },
        { type: 'gemini', text: '4' },
      ];
      const result = extractConversationContext(history, 2);
      expect(result).toBe('user: 3\nassistant: 4');
    });

    it('handles a mix of gemini and gemini_content', () => {
      const history = [
        { type: 'user', text: 'tell me more' },
        { type: 'gemini', text: 'Here is part 1.' },
        { type: 'gemini_content', text: 'Here is part 2.' },
      ];
      const result = extractConversationContext(history);
      expect(result).toBe(
        'user: tell me more\nassistant: Here is part 1.\nassistant: Here is part 2.',
      );
    });
  });
});
