# Vibe Mode

Vibe Mode is an interactive prompt drafting component that helps you compose
high-quality, context-aware prompts for Gemini through a guided, menu-driven
interface.

## Overview

Vibe Mode transforms the standard linear input into a rich, exploratory drafting
experience. Instead of typing a full prompt from scratch, you can:

- **Select Intents:** Choose from high-level goals (e.g., "Refactor", "Debug",
  "Implement").
- **Explore Variants:** Toggle between different phrasings of the same intent.
- **Iterative Drafting:** Generate an initial draft and then refine it
  sentence-by-sentence.
- **Context Awareness:** Suggestions are automatically seeded with your
  conversation history and current workspace state.

## Key Features

### 1. @-Mention Autocomplete

Directly link your prompt to specific files or symbols in your project.

- **Syntax:** Type `@` followed by a file path (e.g., `@src/index.ts`).
- **Fuzzy Search:** The autocomplete menu uses fuzzy matching to help you find
  files quickly.
- **Context Injection:** When you mention a file, Vibe Mode automatically
  includes a summarized version of that file's content in the prompt context.

### 2. Smart Snippetization

To keep LLM calls fast and efficient, Vibe Mode uses "Smart Snippetization" for
mentioned files:

- Small files are sent in full.
- Large files are summarized by including:
  - Important imports and exports.
  - The first 20 lines (header/setup).
  - The last 20 lines (footer/conclusion).
- This ensures the model gets the "signal" of the file without exceeding token
  limits.

### 3. Styled Prompt UI

The drafting area features a rich UI that distinguishes different types of
content:

- **Mentions:** Highlighted in **Cyan** (e.g., `@VibeInput.tsx`).
- **Placeholders:** Highlighted in **Yellow** (e.g., `[file path]`).
- **Active Selection:** The current sentence or placeholder being refined is
  highlighted in **Magenta**.

## Keyboard Shortcuts

| Shortcut                        | Action                                          |
| :------------------------------ | :---------------------------------------------- |
| `Ctrl + Space`                  | Toggle Vibe Mode                                |
| `j` / `k` (or `Up` / `Down`)    | Navigate options or variants                    |
| `h` / `l` (or `Left` / `Right`) | Toggle between variants or navigate sentences   |
| `Tab`                           | Confirm selection and advance to the next depth |
| `Enter`                         | Generate draft or submit the final prompt       |
| `/`                             | Enter free-text / direction mode                |
| `@`                             | Trigger file autocomplete (in free-text mode)   |
| `[`                             | Cycle through placeholders in the draft         |
| `Esc`                           | Go back one level or exit Vibe Mode             |

## How it Works

Vibe Mode uses a fast, stateless LLM (`gemini-2.5-flash-lite`) to generate
suggestions in the background. This ensures the interface remains responsive
while providing high-quality, contextually relevant options.
