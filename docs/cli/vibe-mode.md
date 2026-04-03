# Vibe Mode

Vibe Mode is an interactive prompt drafting component that helps you compose
high-quality, context-aware prompts for Gemini through a guided, menu-driven
interface. It eliminates the "blank page" problem by suggesting next steps or
refining your rough drafts into precise instructions.

## Overview

Vibe Mode transforms the standard linear input into a rich, exploratory drafting
experience. Depending on whether you have already started typing, it operates in
one of two modes:

- **Mode A: Next Prompt Suggestions:** If your input is empty, Gemini CLI
  analyzes your conversation history and workspace state to suggest logical next
  steps (e.g., "Summarize recent changes," "Fix lint errors in the current
  file").
- **Mode B: Draft Refinement:** If you have a rough draft, Gemini CLI generates
  targeted clarifying questions to help you specify missing details, such as
  preferred implementation patterns or specific files to target.

## Key Features

### 1. Context Awareness

Suggestions and clarifying questions are automatically seeded with:

- **Conversation History:** Recent messages and tool outputs.
- **Workspace State:** Git status, changed files, and project structure.

### 2. Draft Refinement via Clarifying Questions

Instead of manually editing a long prompt, you answer a few focused questions.
Gemini CLI then assembles these answers into a polished, professional prompt
that the model can execute more effectively.

### 3. @-Mention Autocomplete

Directly link your prompt to specific files or symbols in your project.

- **Syntax:** Type `@` followed by a file path (e.g., `@src/index.ts`).
- **Fuzzy Search:** The autocomplete menu uses fuzzy matching to help you find
  files quickly.
- **Context Injection:** When you mention a file, Vibe Mode automatically
  includes a summarized version of that file's content in the prompt context.

## Keyboard Shortcuts

<!-- prettier-ignore -->
> [!NOTE]
> Vibe Mode uses `High` priority keypress handling. While active, standard input
> is suspended until you submit or cancel.

| Shortcut       | Action                                                        |
| :------------- | :------------------------------------------------------------ |
| `Ctrl + Space` | Toggle Vibe Mode / Regenerate suggestions / Refine typed text |
| `Ctrl + Y`     | YOLO Mode: Immediately refine and submit the current draft    |
| `j` / `k`      | Navigate through suggestions or options                       |
| `Tab`          | Select an option and advance to the next question             |
| `Enter`        | Submit the final composed prompt                              |
| `Esc`          | Cancel and return to normal input (or go back from review)    |

## YOLO Vibe Mode

For power users who want the benefits of Vibe Mode refinement without the
interactive Q&A, **YOLO Vibe Mode** provides a "fast path" to submission.

When you have a rough draft typed, press `Ctrl + Y` instead of `Ctrl + Space`.
Gemini CLI will:

1.  **Skip** all clarifying questions.
2.  **Automatically refine** your prompt using available context.
3.  **Immediately submit** the refined prompt to the model.

This is ideal for quickly "vibing up" a clear but informal instruction (e.g.,
typing `fix the lint` and pressing `Ctrl + Y` to send a polished refactoring
request).

## Common Workflows

### Refining a Vague Instruction

If you have a general idea but aren't sure about the specifics, Vibe Mode can
help bridge the gap.

1. Type a rough draft: `refactor the auth logic`.
2. Press `Ctrl + Space`.
3. Gemini CLI identifies that "auth logic" is broad and asks:
   - "Which specific files should be refactored?"
   - "Should we prioritize performance or readability?"
4. After you select your preferences, it generates a refined prompt like:
   `Refactor the authentication logic in @src/auth/service.ts to improve readability and simplify the token validation flow.`

### Exploring Next Steps

When you finish a task and aren't sure what to do next, let Vibe Mode suggest
logical continuations.

1. Ensure your input is empty.
2. Press `Ctrl + Space`.
3. Choose from suggestions like:
   - "Run tests for the changes I just made."
   - "Document the new API endpoints in docs/api.md."
   - "Check for any TODOs I might have missed."
