# Hedera Agent UI Components Reference Samples

This folder contains a clean, split collection of high-fidelity React (TSX) and CSS Module files extracted from the original `samples.txt` file.

These files serve as reference implementations for modern agentic UI/UX states (e.g., progress loaders, tool traces, interactive human-in-the-loop approvals, and rich text prompt input editors).

---

## Component Index

### 1. [LoadingState.tsx](file:///Users/fadex/Documents/hedera-x402/samples/LoadingState.tsx)
- **Description**: Pixel-grid wavefront loading animation designed for long-running processes.
- **Key Features**:
  - live elapsed timer (mono tabular numerals).
  - Variants: `Drive` (square wavefront sweep), `Dots` (circular cells), and `Orbit` (comet perimeter lap).
  - Reduced-motion safe (freezes pixel grids to static low opacity).

### 2. [ThinkingState.tsx](file:///Users/fadex/Documents/hedera-x402/samples/ThinkingState.tsx)
- **Description**: Expandable, vertical timeline trace visualizing agent reasoning stages and tool usage.
- **Variants**:
  - `Steps`: Step checklist utilizing spinners and completion checkmarks.
  - `Reasoning`: Unfolding sentence-by-sentence prose.
  - `Search`: Web-search queries paired with clickable supplier source lists.
  - `Coding`: File reads, edits showing line diff metrics, and command run indicators.

### 3. [ApprovalCard.tsx](file:///Users/fadex/Documents/hedera-x402/samples/ApprovalCard.tsx)
- **Description**: Form card built for human-in-the-loop decisions.
- **Key Features**:
  - Multiple choice radio buttons, multiple answer checkbox items, and custom text inputs.
  - Elongated pill indicator representing step progress.
  - Smooth card page-fade transitions on advance.

### 4. Sentence-by-Sentence Reasoning Animator
- **Files**: [ThinkingReasoning.tsx](file:///Users/fadex/Documents/hedera-x402/samples/ThinkingReasoning.tsx) & [ThinkingReasoning.module.css](file:///Users/fadex/Documents/hedera-x402/samples/ThinkingReasoning.module.css)
- **Description**: Linear progression of sentence chunks that fade into view. Once complete, it folds into a summary pill which can be toggled by the user. Includes soft vertical edge masks while scrolling.

### 5. Simple Shimmer Loader
- **Files**: [ThinkingStateSimple.tsx](file:///Users/fadex/Documents/hedera-x402/samples/ThinkingStateSimple.tsx) & [ThinkingStateSimple.module.css](file:///Users/fadex/Documents/hedera-x402/samples/ThinkingStateSimple.module.css)
- **Description**: Minimalist shimmering text loader for quick agent actions.

### 6. Interactive Checklist (To-dos)
- **Files**: [TodoList.tsx](file:///Users/fadex/Documents/hedera-x402/samples/TodoList.tsx) & [TodoList.module.css](file:///Users/fadex/Documents/hedera-x402/samples/TodoList.module.css)
- **Description**: A progress tracker featuring item entry slide-ups, checkmark cross-fades, and a circular progress pie.
- **Key Features**:
  - `RollingCount` component that vertically rolls digits on numeric updates (e.g. `2/5` -> `3/5`).

### 7. Brand DataTable Comparison
- **Files**: [DataTable.tsx](file:///Users/fadex/Documents/hedera-x402/samples/DataTable.tsx) & [DataTable.module.css](file:///Users/fadex/Documents/hedera-x402/samples/DataTable.module.css)
- **Description**: Comparison grids (pricing/metrics) utilizing inline brand SVGs for OpenAI, Anthropic, and Meta.

### 8. Rich Agent Prompt Input
- **Files**: [PromptInput.tsx](file:///Users/fadex/Documents/hedera-x402/samples/PromptInput.tsx) & [PromptInput.module.css](file:///Users/fadex/Documents/hedera-x402/samples/PromptInput.module.css)
- **Description**: Core interface for user-agent interaction.
- **Key Features**:
  - ContentEditable div enabling inline injection of deletable skill pills (e.g., `/Deep Research`).
  - Dropdown menu for model selection and file upload attachments.
  - Slash command palette (e.g., typing `/` displays a listbox of available skills).
  - "Enhance Prompt" action button utilizing abort controllers to cancel in-flight API requests, paired with a conic-gradient border-sweep loader around the card perimeter.
  - FLIP animation transitions to prevent height jumping.
