import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useImperativeHandle, useLayoutEffect, useRef, useState, useCallback, type ReactNode, type Ref } from 'react';
import type { PrChangeFile } from '../lib/pr-changes';

export interface CommitDiffStreamHandle {
  scrollToFile: (key: string) => void;
  preservePosition: () => void;
}
interface StreamFile {
  key: string;
  file: PrChangeFile;
  viewed: boolean;
}
/** One scroll surface, with bounded diff mounts and measured file heights. */
export function CommitDiffStream({
  files,
  initialPosition,
  selected,
  onPosition,
  renderFile,
  completion,
  ref,
}: {
  files: StreamFile[];
  initialPosition: { key: string; offset: number };
  selected: string;
  onPosition: (key: string, offset: number) => void;
  renderFile: (key: string, next: () => void) => ReactNode;
  completion?: ReactNode;
  ref?: Ref<CommitDiffStreamHandle>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const initial = useRef(initialPosition);
  const pending = useRef<{ key: string; offset: number; until: number; focus?: boolean } | undefined>(
    initial.current.key ? { ...initial.current, until: Date.now() + 1500 } : undefined
  );
  const current = useRef({ files, onPosition });
  current.current = { files, onPosition };
  const [focused, setFocused] = useState<string>();
  // Keep interacted discussions alive until leaving this comparison. In-flight
  // writes and unsaved edits must not disappear when their row scrolls offscreen.
  const [discussions, setDiscussions] = useState<Set<string>>(() => new Set());
  function retainDiscussion(target: HTMLElement) {
    if (!target.closest('.github-thread, .changes-comment-composer, .changes-draft-comment')) return;
    const key = target.closest<HTMLElement>('[data-file]')?.dataset.file;
    if (key) setDiscussions((old) => (old.has(key) ? old : new Set([...old, key])));
  }
  const keyAt = useCallback((i: number) => current.current.files[i].key, []);
  const virtual = useVirtualizer({
    count: files.length,
    getScrollElement: () => viewport.current,
    getItemKey: keyAt,
    estimateSize: (i) =>
      files[i].viewed
        ? 92
        : Math.min(1200, Math.max(240, (files[i].file.additions + files[i].file.deletions + 8) * 22 + 92)),
    overscan: 2,
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...files.flatMap((file, index) => (discussions.has(file.key) ? [index] : [])),
          ...(focused ? [files.findIndex((f) => f.key === focused)].filter((i) => i >= 0) : []),
        ]),
      ].sort((a, b) => a - b),
  });
  const items = virtual.getVirtualItems();
  // A filter can hide an edited file while its reply or save is still in flight.
  // Keep the same keyed row (and editor instances) mounted outside the measured list.
  const rows = [
    ...items.map((item) => ({ key: String(item.key), index: item.index, start: item.start, hidden: false })),
    ...[...discussions]
      .filter((key) => !files.some((file) => file.key === key))
      .map((key) => ({ key, index: -1, start: 0, hidden: true })),
  ];
  function jump(key: string, offset = 0, focus = false) {
    const index = current.current.files.findIndex((f) => f.key === key);
    if (index < 0) return;
    pending.current = { key, offset, focus, until: Date.now() + 1500 };
    // Publish the target even if scrolling does not move the viewport. A layout
    // effect may have restored the previous position before this deferred jump.
    current.current.onPosition(key, offset);
    virtual.scrollToIndex(index, { align: 'start' });
  }
  useImperativeHandle(ref, () => ({ scrollToFile: jump, preservePosition: () => {
    if (pending.current) return;
    const top = viewport.current?.scrollTop ?? 0;
    const item = virtual.getVirtualItems().find(row => row.end > top + 2);
    if (item) pending.current = { key: String(item.key), offset: Math.max(0, top - item.start), until: Date.now() + 1500 };
  } }));
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    if (Date.now() > target.until) {
      return;
    }
    const index = files.findIndex((f) => f.key === target.key);
    if (index < 0) {
      pending.current = undefined;
      return;
    }
    const item = items.find((item) => item.index === index);
    if (!item) {
      virtual.scrollToIndex(index, { align: 'start' });
      return;
    }
    const el = viewport.current;
    if (el) {
      el.scrollTop = item.start + Math.min(target.offset, Math.max(0, item.size - 60));
      if (target.focus) {
        const action = el.querySelector<HTMLButtonElement>(`[data-index="${index}"] [data-viewed-next]`);
        if (action) {
          target.focus = false;
          action.focus({ preventScroll: true });
        }
      }
    }
  });
  function remember() {
    const el = viewport.current;
    if (!el) return;
    const target = pending.current;
    if (target && current.current.files.some((f) => f.key === target.key)) {
      current.current.onPosition(target.key, target.offset);
      return;
    }
    const rows = virtual.getVirtualItems();
    const active = rows.find((row) => row.end > el.scrollTop + 2) ?? rows.at(-1);
    if (active)
      current.current.onPosition(current.current.files[active.index].key, Math.max(0, el.scrollTop - active.start));
  }
  useLayoutEffect(() => {
    remember();
  }, [virtual.scrollOffset, files]);
  return (
    <div
      className="changes-code-scroll commit-diff-stream"
      ref={viewport}
      tabIndex={0}
      aria-label="All files in this comparison"
      onWheel={() => {
        pending.current = undefined;
      }}
      onPointerDown={(event) => {
        retainDiscussion(event.target as HTMLElement);
        pending.current = undefined;
      }}
      onKeyDown={() => {
        pending.current = undefined;
      }}
      onClickCapture={(event) => retainDiscussion(event.target as HTMLElement)}
      onFocusCapture={(event) => {
        retainDiscussion(event.target as HTMLElement);
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-file]');
        if (row) setFocused(row.dataset.file);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(undefined);
      }}
      onScroll={remember}
    >
      <div className="commit-stream-content" style={{ height: virtual.getTotalSize() }}>
        {rows.map((item) => {
          return (
            <div
              key={item.key}
              ref={item.hidden ? undefined : virtual.measureElement}
              hidden={item.hidden}
              data-index={item.index}
              data-file={item.key}
              data-active={!item.hidden && item.key === selected}
              className="commit-stream-row"
              style={{ position: 'absolute', top: item.start, left: 0, width: '100%' }}
            >
              {renderFile(item.key, () => {
                const next = [...files.slice(item.index + 1), ...files.slice(0, item.index)].find((f) => !f.viewed);
                if (next) jump(next.key, 0, true);
              })}
            </div>
          );
        })}
      </div>
      {completion}
    </div>
  );
}
