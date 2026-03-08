# PROMPTS

This file documents the main AI prompts, prompt patterns, and AI-assisted development workflows used while building EternalOS.

The project uses AI in two different ways:

1. **Product AI**
   - grounded chat over desktop state
   - image metadata enrichment
2. **Development-time AI assistance**
   - implementation help
   - debugging
   - refactoring
   - architecture iteration

## Product Prompts

### Ask Eternal: grounded desktop chat

System prompt pattern used for the chat agent:

- The assistant is grounded in the user’s real desktop state.
- It must use server tools instead of inventing files or actions.
- It should answer questions about:
  - desktop contents
  - uploaded files
  - image tags
  - OCR text
  - recent uploads
- For mutations, it should rely on tool approval rather than free-text action guessing.

Representative instructions used in the agent:

- "You are Ask Eternal, a grounded assistant for a user desktop running on Cloudflare."
- "Use the server tools to inspect or mutate the desktop."
- "Do not invent files, tags, captions, colors, OCR text, or search results."
- "For desktop inventory questions, call getDesktopOverview before answering."
- "For search, count, or matching requests, call searchDesktop with the user request."
- "For requests to group, collect, organize, or create a folder from matching items, call createFolderFromMatches."
- "After tool results are available, answer in one or two concise sentences."

### Image metadata enrichment

Prompt pattern used for uploaded image analysis:

- caption the image
- extract useful tags
- extract visible text when present
- return structured output
- avoid guessing deterministic properties that can be computed directly

Representative goals:

- "Describe what is visibly in this image."
- "Return short, searchable tags."
- "Extract any visible text."
- "Do not fabricate text that is not visible."

Note:

- Dominant colors were later moved out of the AI prompt and made deterministic in the worker.

## Development-Time AI Prompts

The following are representative prompt categories used while building and refining the project.

### Architecture / Cloudflare design

- "Analyze this repo."
- "What should we tackle next?"
- "How do we improve the AI part?"
- "How do we make this fit the Cloudflare AI assignment?"
- "How should Durable Objects, KV, R2, and Workers AI be split for this app?"

### AI assistant / chat iteration

- "Implement the AI assistant."
- "Switch to a more agentic approach."
- "Add screenshot-level judgment."
- "Replace brittle parsing with structured tool calling."
- "Make the chat grounded in desktop state."
- "Use the documented Cloudflare Agents approach instead of ad hoc text parsing."

### Image AI / metadata

- "Use AI to scan images and add metadata."
- "Let users search images by what is in them."
- "Add OCR text, tags, and captions."
- "Let users add their own tags too."
- "Add synonym-aware search."
- "Move dominant color extraction out of AI and make it deterministic."

### UI / customization

- "Improve the custom CSS workflow."
- "Add save states for custom CSS."
- "Make customization more intricate with color pickers and border radius controls."
- "Remove overlapping theme logic and focus on direct appearance customization."
- "Make the UI styling more consistent with the rest of the site."

### Performance / debugging

- "Find the issue with dragging stuff around the desktop, it's slow and janky."
- "Fix the stuck drag state."
- "Why is search not working?"
- "Why is image analysis failing?"
- "Fix the live preview / visitor ordering bugs."

## Representative User-Facing Demo Prompts

These are good examples of the kinds of prompts the app is designed to support:

- `What is on my desktop right now?`
- `How many anime images are there?`
- `Find images related to roads`
- `Which recent images contain text?`
- `Create a folder from those matches called Anime`

## Notes On Originality

- The implementation was developed specifically for this project and iterated in-place on this codebase.
- AI assistance was used as a coding and debugging aid, not as a source to copy another submission.
- The final code, architecture, and product integration were adapted to EternalOS specifically.
