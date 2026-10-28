# Chat experience

Mode: Operate / Read.

## Direction contract

Engineers ask about a topic or file while inspecting code on a laptop. Preserve the cool-neutral workbench, existing type tokens, and both themes. Keep revision/topic context visible and the diff usable alongside chat.

Use current shadcn MessageScroller, Message, and InputGroup compositions. Anchor each question near the top; manual scrolling pauses follow. Offer Jump to latest. Questions use a subtle surface; answers are unboxed Markdown. The compact composer stays editable while answers stream. Provide Stop, copy, and retry with partial answers retained. Quoted code is inspectable and removable. Preserve per-conversation drafts and existing keyboard/IME behavior.

No change to the product visual system or global Button/Tooltip primitives.

## Laptop integration

Active chat uses a one-row composer that grows with its draft. Metadata and keyboard help use existing caption tokens. Condense repeated PR metadata and topic navigation only while chat is visible; keep source identity, review status, and navigation available. At 1280×720 and 900×720, verify at least 240px of transcript in the complete workbench, not only a standalone fixture.

Code selections remain collapsed attachments in both chat types and enter model context on send and retry. Explicit file-chat opening transfers focus to the input; closing restores its initiating control. Keep failed questions in the transcript with Retry, preserving any new composer draft. Announce completion, interruption, and cancellation distinctly.
