import { useCallback, type CSSProperties, type ReactNode } from 'react';
import { DIFFS_TAG_NAME, type FileDiffMetadata } from '@pierre/diffs';
import {
  renderDiffChildren,
  templateRender,
  useFileDiffInstance,
  type DiffLineAnnotation,
  type FileDiffOptions,
} from '@pierre/diffs/react';
import { keepHost } from '../lib/kept-host';

/**
 * Pierre's React `FileDiff`, except that its instance outlives a hidden Activity (lib/kept-host.ts): the Changes tab
 * stays mounted while another PR tab shows, and coming back to a 3,000-line file no longer renders it again (#352).
 */
export function KeptFileDiff<A>({
  fileDiff,
  options,
  lineAnnotations,
  renderAnnotation,
  style,
}: {
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<A, undefined>;
  lineAnnotations: DiffLineAnnotation<A>[];
  renderAnnotation: (annotation: DiffLineAnnotation<A>) => ReactNode;
  style: CSSProperties;
}) {
  const {
    ref,
    getHoveredLine,
    getAnnotationSlotName,
    fileDiff: renderedDiff,
    lineAnnotations: renderedAnnotations,
  } = useFileDiffInstance<A, undefined>({
    fileDiff,
    options,
    editorOptions: undefined,
    editStateKey: undefined,
    lineAnnotations,
    selectedLines: undefined,
    prerenderedHTML: undefined,
    hasGutterRenderUtility: false,
    hasCustomHeader: false,
    disableWorkerPool: false,
    edit: false,
  });
  const keep = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      return keepHost(element, ref, () => ref(element), () => ref(null));
    },
    [ref]
  );
  const children = renderDiffChildren<A, undefined, never>({
    fileDiff: renderedDiff,
    renderCustomHeader: undefined,
    renderHeaderPrefix: undefined,
    renderHeaderMetadata: undefined,
    renderAnnotation,
    renderGutterUtility: undefined,
    lineAnnotations: renderedAnnotations,
    getHoveredLine,
    getAnnotationSlotName,
  });
  const Tag = DIFFS_TAG_NAME as 'div';
  return (
    <Tag ref={keep} style={style}>
      {templateRender(children, undefined)}
    </Tag>
  );
}
