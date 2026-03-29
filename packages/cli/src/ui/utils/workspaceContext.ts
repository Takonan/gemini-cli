/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';

/**
 * Gathers a brief summary of the current workspace state
 * (git status, recent files, etc.) to seed Vibe suggestions.
 */
export function getWorkspaceContext(): string {
  let context = '';

  try {
    // 1. Get git status (porcelain is stable for parsing/summarizing)
    const gitStatus = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();

    if (gitStatus) {
      context += `Git Status:\n${gitStatus.slice(0, 500)}\n\n`;
    }
  } catch {
    // Git might not be initialized or available; skip silently.
  }

  try {
    // 2. Get a quick list of files in the current directory
    const lsOutput = execSync('ls -F', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();

    if (lsOutput) {
      context += `Current Directory Files:\n${lsOutput.slice(0, 500)}\n\n`;
    }
  } catch {
    // ls might fail on some platforms/envs; skip silently.
  }

  return context.trim();
}
