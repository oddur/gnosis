---
version: 1
slug: 'components-workspacetabs-tsx'
primary_target: 'components/WorkspaceTabs.tsx'
related_targets: ['src/App.tsx', 'src/ReviewWorkspace.tsx', 'src/workspace-tabs.css', 'lib/workspace-tabs.ts']
---

# Workspace tabs

Mode: Operate. This ordinary extension adds the approved compact browser-style tabs, variant A, to the existing Gnosis workbench.

## Direction contract

THESIS: Keep several reviews available without losing the active review's place. Show one active workspace at a time.

OWN-WORLD: Existing cool workbench surfaces, blue selection, thin borders, Plus Jakarta Sans, and shared identity icons. No new visual system.

STORY: Open another destination, switch between reviews, then resume each review's section, reading position, and composer within the session.

FIRST VIEWPORT: A compact horizontal tab strip above the existing header. Each tab shows an icon, title, optional PR number, and close control.
The plus button opens a queue tab. The Open tabs menu provides access to overflow destinations.

FORM: User-approved variant A. Horizontal overflow preserves useful tab widths. Split views are outside this extension.

## Implemented extension

The strip is 39px high. Tabs are 240px wide, reduced to 210px at viewport widths of 1000px or less.
The list has a 4px gap and 3px top inset. Upper tab corners have a 6px radius.
Titles use inherited Plus Jakarta Sans at 12px and weight 550. PR numbers use 11px and weight 400.
These compact values belong to this surface and do not change the global type ramp.

The strip uses `sidebar`. Active tabs use `background`, `foreground`, and `border`, with a 2px inset top line from `ring`.
Inactive text uses `muted-foreground`. Hover uses `accent`. Visible keyboard focus uses a 2px `ring` outline.
The same semantic tokens supply light and dark themes. The tab line communicates selection, without adding elevation.

The workspace retains the existing 34px Activity reservation. At heights of 750px or less, the shared header uses a 48px minimum height.
Its vertical padding reduces to 6px within the workspace shell. This local adjustment preserves content height under the new strip.

Native title tooltips expose truncated metadata. Named tab and panel relationships, roving keyboard focus, and inert inactive panels support keyboard navigation.
Horizontal scrolling and the Open tabs menu keep every destination reachable. The strip adds no motion or raster assets.

## Behavior boundary

Each visited tab retains its live navigation, reading position, and composer scope. Shared caches, Viewed progress, and background services retain their existing owners.
Unopened background tabs mount on first activation. Hidden React `Activity` pauses effects in visited inactive tabs.
One global Activity drawer and command surface serve the active workspace.

Restart restoration saves only open destinations and navigation metadata through the existing account-specific SQLite store.
It does not promise restoration of component state, draft text, Back/Forward history, or closed-tab history.
The [behavior reference](../../docs/workspace-tabs.md) defines shortcuts, menus, account changes, and restoration limits.

## Finish evidence

The finish reviewer returned **SHIP** after the workspace isolation correction. The tab browser checks passed switching, restoration, independent composers, and account reset.
The compact-header adjustment passes the existing chat checks: the file conversation has 243px of reading space at 1280 × 720. Explanation, sidebar, navigation history, setup, and shell regression checks also pass in Docker.

Reviewed captures:

- [Desktop queue](../review/desktop.png)
- [Laptop queue](../review/laptop.png)
- [Changes](../review/changes.png)
- [Explanation and chat](../review/explanation-tabs.png)
- [Dark explanation and chat](../review/dark-tabs.png)

These captures are review evidence, not shipping raster assets.

The extension preserves [DESIGN.md](../../DESIGN.md), [PRODUCT.md](../../PRODUCT.md), and the global design sidecar.
DESIGN.md retains its older baseline commit marker and later component additions after Do's and Don'ts. This pre-existing documentation drift remains outside this extension.
The new tab geometry and compact-header exception remain local here. They do not redefine the incumbent system.

## Harden, onboard, optimize, polish pass

The strip remains 39px tall. Close targets are at least 26px. The overflow list separates each title from its repository, PR number, and section. Long titles truncate without widening the workbench. Opening indicators respect reduced motion; a warning icon identifies a failed destination.

A single-tab hint teaches modified-click opening. It can be dismissed and disappears after a second tab opens. Help retains the complete instructions. No tour or blocking onboarding is added.

Keyboard context menus restore focus. Closing other tabs is atomic and retains the requested tab. Failed loads offer Retry or Review queue; a render error stays inside its workspace. Queue scrolling survives an immediate tab switch, including browser scroll events dispatched after the workspace becomes hidden.

Docker checks pass for workspace tabs, tab hardening, shared context menus, navigation history, and shell hardening. Captures cover light/dark overflow, long multilingual titles, network retry, render recovery, and a 700px window at 150% zoom. Native macOS pointer behavior and screen-reader announcements were not tested in this pass.

In a 40-tab fixture with 50 queue scroll updates, a test-only React Profiler around the strip measured 50 strip commits / 305ms before, and 0 strip commits / 0ms after. Whole-App rendering in that paired run was 469ms before and 227ms after. Broader timings varied across runs; these are fixture measurements, not a general app speed claim. The optimization skips unchanged chrome and releases draft scopes after they leave the closed-tab history.

Pass captures (review evidence only):

- [First-tab hint](../review/tabs-hardening/first-tab.png)
- [Overflow menu](../review/tabs-hardening/overflow-menu.png)
- [Dark overflow](../review/tabs-hardening/overflow-dark.png)
- [Failed destination](../review/tabs-hardening/retry.png)
- [Workspace recovery](../review/tabs-hardening/tab-recovery.png)
- [Narrow window at 150% zoom](../review/tabs-hardening/narrow-zoom.png)

## Drag reordering

Tabs can be dragged by their title area. A narrow `ring` insertion marker shows the drop position; the source tab dims while dragging. The strip keeps its 39px height. Holding the drag near an edge scrolls overflowing tabs. The active workspace stays mounted, and the saved order updates on drop. Move tab left/right remain keyboard-accessible menu alternatives.

The Docker hardening fixture uses synthesized Chromium drag events to verify moves in both directions, stored order, active-workspace retention, immediate Escape, window blur, drag end, and edge scrolling with 40 tabs. The insertion marker was visually inspected in [the drag capture](../review/tabs-hardening/drag-insertion.png). Physical macOS drag input was not exercised in this pass.

## Live listing status

Listing tabs retain the compact strip geometry and show a non-truncating `(N)` count next to the title. The title and count use bold text while any matching PR is unread. The accessible tab name states “Unread PRs.” Detail tabs retain their existing titles. Background changes use shared cache notifications rather than per-tab GitHub requests.

The Docker workspace-tabs check verifies hidden-tab counts, bold unread state, read-state updates, and notification coalescing without GitHub discovery. [Listing count capture](../review/tabs-counts/listing-counts.png).
