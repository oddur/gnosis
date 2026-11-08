# Workspace tabs

Workspace tabs keep several review destinations open in one window. One tab is active at a time. Split views are outside this feature.

Each tab owns its navigation history, selected review section, and live reading position. The same review can appear in several tabs.
Chat composers and session drafts have separate workspace scopes. Review progress, cached source data, discussions, and background work retain their shared stores.

## Open and select tabs

The plus button opens the review queue in a new active tab. The Open tabs menu lists every tab, including tabs outside the visible strip.
The command palette includes New tab, Reopen closed tab, and commands to switch to each open tab.

Supported destinations include queue PR and stack titles, completed saved reviews, and queue sidebar destinations.

| Interaction                                     | Result                  |
| ----------------------------------------------- | ----------------------- |
| Cmd-click or Ctrl-click a supported destination | Open a background tab   |
| Cmd-Shift-click or Ctrl-Shift-click             | Open and activate a tab |
| Middle-click a supported destination            | Open a background tab   |
| Open in new tab in a destination menu           | Open and activate a tab |
| Click a tab                                     | Activate that tab       |
| Middle-click a tab or click its close button    | Close that tab          |

Queue selection gestures remain separate from title navigation. Shift-click alone does not open a foreground tab.

The strip scrolls horizontally. Vertical wheel movement also scrolls the strip, and the active tab moves into view.
Each tab shows an identity icon, its title, and a close button. PR tabs also show the PR number.
Long titles truncate. A native tooltip contains the full title, destination metadata, and section.
The Open tabs menu shows a second line with the repository, PR number, and section to distinguish similar titles.
A dismissible hint introduces modified-click opening. It disappears after opening a second tab. Help keeps the full shortcut reference available.

## Keyboard and menus

Cmd and Ctrl shortcuts both work. Electron intercepts these shortcuts before native window actions.

| Shortcut                              | Action                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| Cmd/Ctrl+T                            | Open a new queue tab                                       |
| Cmd/Ctrl+W                            | Close the active tab                                       |
| Cmd/Ctrl+Shift+T                      | Reopen the most recently closed tab                        |
| Ctrl+Tab                              | Select the next tab in strip order                         |
| Ctrl+Shift+Tab                        | Select the previous tab in strip order                     |
| Cmd/Ctrl+1–8                          | Select that position, or the final tab if fewer tabs exist |
| Cmd/Ctrl+9                            | Select the final tab                                       |
| Left/Right Arrow, with focus on a tab | Select and focus the adjacent tab                          |
| Home/End, with focus on a tab         | Select and focus the first/final tab                       |

Tab shortcuts pause while a visible modal dialog is open. Repeated keys, composition input, and Alt combinations do not trigger tab actions.

Each tab has a context menu with Close tab, Close other tabs, Move tab left, Move tab right, and Reopen closed tab.
Shift+F10 or the Context Menu key opens this menu from a focused tab. Closing the menu restores focus; closing a tab focuses the surviving active tab.
Close other tabs keeps the chosen tab, even when that tab was inactive.
The Open tabs menu also offers Reopen closed tab. Drag a tab to reorder it; an insertion marker shows where it will land. Holding near either edge scrolls an overflowing strip. Escape, dropping outside the strip, or losing window focus cancels the drag. The current review stays active, and the new order is saved. The Move tab left/right menu actions provide the keyboard alternative.

Closing the active tab selects the most recently active remaining tab. Closing the final tab opens a fresh queue tab.
The session retains up to 20 closed destinations. Reopening restores the destination, but does not retain the closed component tree or its navigation history.

## State and restoration

Unopened background tabs do not mount their review workspace. Their first activation loads the destination.
Visited inactive tabs retain their React state through `Activity`. Hidden mode stops their effects, while hidden and inert panels prevent inactive interaction.
Global commands, Activity, and notification surfaces remain shared. Review actions target the active workspace.

The existing SQLite review-state store saves tabs under `gnosis-workspace-tabs:v1:<account>`.
The record contains tab order, active tab, labels, and destination metadata. Home destinations can include filters, the selected section, selection, and scroll metadata.
Saved explanations retain their review identifier. Restoration resolves subjects from the current queue, with a PR URL fallback where available.

Restart restoration does not serialize component state, Back/Forward history, closed-tab history, cached code, PR descriptions, or draft text.
Live position and composer retention during tab switches does not imply complete restoration after a restart.

Account changes save the outgoing destinations, discard mounted workspaces, and restore the incoming account's tabs.
Invalid saved records fall back to a queue tab. Failed saves retain live tabs and show “Could not save open tabs.”
Invalid entries do not discard valid neighboring entries. Failed saves offer Retry and do not repeat the toast on every scroll.
Failed destination loads stay in the affected tab, show a warning icon, and offer Retry or Review queue.
Each workspace has a render error boundary. Retry tab remounts that workspace; the tab strip and other workspaces remain usable.
Session drafts are released after their tab leaves both the open tabs and the 20-entry closed-tab history.
Queue scroll position is captured before a workspace becomes hidden, including scroll events still pending in the browser.

## Implementation and checks

[WorkspaceTabs](../components/WorkspaceTabs.tsx) owns the strip and menus.
[App](../src/App.tsx) owns account scope, persistence, shortcuts, and tab lifecycle.
[ReviewWorkspace](../src/ReviewWorkspace.tsx) owns each tab's navigation.
[workspace-tabs](../lib/workspace-tabs.ts) defines transitions and saved metadata.

[Unit tests](../tests/workspace-tabs.test.ts) cover tab transitions, shortcuts, and saved records.
[Browser checks](../tests/workspace-tabs-browser.ts) cover background opening, retained Changes, explanation positions, independent composers, restoration, and account reset.
[Hardening checks](../tests/workspace-tabs-hardening-browser.ts) cover 40 tabs, long multilingual titles, keyboard menus, focus recovery, close others, network retry, renderer recovery, hint dismissal, and a narrow window at 150% zoom.
The strip skips rerenders when only reading-position metadata changes. The hardening fixture includes a React Profiler benchmark; set `GNOSIS_TABS_BENCH=1` to run only the measurement.
Browser checks run through Docker, as required by [AGENTS.md](../AGENTS.md).

The [surface brief](../.impeccable/surfaces/components-workspacetabs-tsx.md) records the visual treatment and finish evidence.
