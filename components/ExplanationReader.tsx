import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { explanationPositionKey, useExplanationScroll } from '../lib/use-explanation-scroll';
import { createColumnLayout, type ColumnLayout } from '../lib/explanation-column-layout';
import type { ReviewGuide, Slide } from '../lib/types';

export interface ExplanationReaderHandle {
  navigate: (section: number) => void;
  showCode: (section?: number) => void;
}
interface Props {
  ref?: Ref<ExplanationReaderHandle>;
  review: ReviewGuide;
  inspected: number;
  active?: boolean;
  chatOpen: boolean;
  viewedFiles: Set<string>;
  renderSection: (slide: Slide, index: number) => ReactNode;
  renderCode: (slide: Slide, index: number) => ReactNode;
  tool?: ReactNode;
  actions?: ReactNode;
  onReadingSection: (index: number) => void;
  onOpenChanges?: () => void;
  onReview?: () => void;
}
export function ExplanationReader({
  ref,
  review,
  inspected,
  active = true,
  chatOpen,
  viewedFiles,
  renderSection,
  renderCode,
  tool,
  actions,
  onReadingSection,
  onOpenChanges,
  onReview,
}: Props) {
  const id = `${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`;
  const reading = useExplanationScroll(explanationPositionKey(id, 'reading'), active);
  // One observer and one frame of writes for every sticky column, instead of one forced layout per section.
  // Ref cleanups unobserve each element, so a hidden or closed tab leaves nothing observed.
  const [columnLayout] = useState(() => createColumnLayout());
  const readingRef = reading.ref;
  const documentRef = useCallback(
    (element: HTMLDivElement | null) => {
      readingRef(element);
      columnLayout.viewport(element);
    },
    [readingRef, columnLayout]
  );
  const [section, setSection] = useState(0);
  const frame = useRef(0);
  const navigationFrame = useRef(0);
  const lastSection = useRef(0);
  const sectionElements = useRef<HTMLElement[]>([]);
  useEffect(() => {
    sectionElements.current = [
      ...(reading.node.current?.querySelectorAll<HTMLElement>('[data-explanation-section]') ?? []),
    ];
    trackReading();
  }, [review]);
  const navigating = useRef(false);
  useEffect(() => {
    if (!active) {
      navigating.current = false;
      cancelAnimationFrame(navigationFrame.current);
      cancelAnimationFrame(frame.current);
    }
  }, [active]);
  useEffect(() => {
    const element = reading.node.current;
    if (!element) return;
    const settled = () => {
      navigating.current = false;
    };
    element.addEventListener('scrollend', settled);
    return () => element.removeEventListener('scrollend', settled);
  }, [reading.node]);
  const [revealed, setRevealed] = useState<number | null>(null);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(navigationFrame.current);
    },
    []
  );
  const files = useMemo(
    () => [
      ...new Set([
        ...(review.changedFiles?.map((f) => f.filename) ?? []),
        ...review.slides.flatMap((s) => [...s.affectedFiles, ...s.diffHunks.map((h) => h.filePath)]),
      ]),
    ],
    [review]
  );
  const covered = useMemo(() => new Set(review.slides.flatMap((s) => s.diffHunks.map((h) => h.filePath))), [review]);
  const remaining = files.filter((f) => !viewedFiles.has(f));
  const uncovered = files.filter((f) => !covered.has(f));
  const unknownFiles = Math.max(0, review.totalFilesChanged - files.length);
  function navigate(requestedIndex: number) {
    const index = Math.max(0, Math.min(review.slides.length, Math.trunc(requestedIndex)));
    if (!Number.isFinite(index)) return;
    setRevealed(index);
    cancelAnimationFrame(navigationFrame.current);
    const origin = window.document.activeElement;
    navigationFrame.current = requestAnimationFrame(() => {
      const container = reading.node.current;
      const target = container?.querySelector<HTMLElement>(`[data-explanation-section="${index}"]`);
      if (!container || !target) return;
      const top = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const destination = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
      navigating.current = !reducedMotion && Math.abs(destination - container.scrollTop) > 1;
      container.scrollTo({ top: destination, behavior: reducedMotion ? 'instant' : 'smooth' });
      const heading = target.querySelector<HTMLElement>('h2') ?? target;
      heading.tabIndex = -1;
      if (window.document.activeElement === origin || window.document.activeElement === window.document.body)
        heading.focus({ preventScroll: true });
      lastSection.current = index;
      setSection(index);
      onReadingSection(index);
      reading.onScroll();
    });
  }
  useImperativeHandle(ref, () => ({
    navigate,
    showCode: (index = inspected) => {
      setRevealed(index);
      cancelAnimationFrame(navigationFrame.current);
      navigationFrame.current = requestAnimationFrame(() => {
        reading.node.current
          ?.querySelector(`[data-explanation-section="${index}"] .explanation-section-code`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    },
  }));
  function trackReading() {
    reading.onScroll();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const container = reading.node.current;
      if (!active || !container || !container.clientHeight || navigating.current) return;
      const top = container.getBoundingClientRect().top + 80;
      // Sections remain in document order. Locate the current section with logarithmic layout reads.
      const sections = sectionElements.current;
      let low = 0;
      let high = sections.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sections[middle].getBoundingClientRect().top <= top) low = middle + 1;
        else high = middle;
      }
      const value = Number(sections[Math.max(0, low - 1)]?.dataset.explanationSection ?? 0);
      if (value === lastSection.current) return;
      lastSection.current = value;
      setSection(value);
      onReadingSection(value);
    });
  }
  const document = (
    <div
      className="explanation-document"
      ref={documentRef}
      onScroll={trackReading}
      onWheelCapture={() => {
        navigating.current = false;
      }}
      onPointerDownCapture={() => {
        navigating.current = false;
      }}
      onKeyDownCapture={() => {
        navigating.current = false;
      }}
      aria-label="Explanation document"
      tabIndex={0}
    >
      <section className="explanation-introduction" data-explanation-section="0" tabIndex={-1}>
        <h2>Change overview</h2>
        <Markdown className="reading-prose">{review.summary}</Markdown>
        <details className="explanation-context explanation-reading-help">
          <summary>How to use this explanation</summary>
          <ul>
            <li>Scroll to read each section alongside its code. Use Next section to skip ahead.</li>
            <li>Mark files Viewed as you inspect them. Progress and comments are shared with Changes.</li>
            <li>Use Ask a question or press C for help with the current section.</li>
          </ul>
        </details>
        {!!review.riskRationale.trim() && (
          <details className="explanation-context">
            <summary>Review context</summary>
            <Markdown className="reading-prose">{review.riskRationale}</Markdown>
          </details>
        )}
      </section>
      {review.slides.map((s, i) => (
        <PairedSection
          key={s.id}
          index={i + 1}
          title={s.title}
          hasCode={s.diffHunks.length > 0}
          forceReady={i < 2 || revealed === i + 1 || (inspected === i + 1 && !!tool)}
          narrative={renderSection(s, i + 1)}
          code={renderCode(s, i + 1)}
          tool={inspected === i + 1 ? tool : undefined}
          layout={columnLayout}
        />
      ))}
      <section className="explanation-ending" aria-label="End of explanation">
        <h2>End of explanation</h2>
        <p>
          {remaining.length + unknownFiles > 0
            ? `${(remaining.length + unknownFiles).toLocaleString()} ${remaining.length + unknownFiles === 1 ? 'file' : 'files'} still unviewed.`
            : 'All known files are marked Viewed.'}
        </p>
        {uncovered.length + unknownFiles > 0 && (
          <p className="text-muted-foreground">
            {(uncovered.length + unknownFiles).toLocaleString()}{' '}
            {uncovered.length + unknownFiles === 1 ? 'file is' : 'files are'} not covered by code excerpts in this
            explanation.
          </p>
        )}
        {!!uncovered.length && (
          <details>
            <summary>Files outside the explanation</summary>
            <ul>
              {uncovered.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="explanation-ending-actions">
          {onOpenChanges && (
            <Button size="sm" variant="outline" onClick={onOpenChanges}>
              Open all changes
            </Button>
          )}
          {onReview && (
            <Button size="sm" onClick={onReview}>
              Review PR
            </Button>
          )}
        </div>
        <p className="explanation-ending-note">
          Reading and Viewed files track your progress. A review decision is sent only when you submit it.
        </p>
      </section>
    </div>
  );
  return (
    <div className="explanation-reader" data-chat-open={chatOpen || undefined}>
      <div className="explanation-reading-toolbar">
        <nav className="explanation-section-navigation" aria-label="Explanation navigation">
          <SearchableSelect
            label="Explanation section"
            value={String(section)}
            onValueChange={(v) => navigate(Number(v))}
            options={[
              { value: '0', label: 'Change overview' },
              ...review.slides.map((s, i) => ({ value: String(i + 1), label: s.title })),
            ]}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous section"
            title="Previous section (← / K)"
            disabled={section === 0}
            onClick={() => navigate(section - 1)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="explanation-next-section"
            title={section < review.slides.length ? `Next: ${review.slides[section]?.title}` : 'Last section'}
            disabled={section >= review.slides.length}
            onClick={() => navigate(section + 1)}
          >
            Next section <ArrowDown size={16} aria-hidden="true" />
          </Button>
        </nav>
        <span className="explanation-file-progress">
          {files.filter((f) => viewedFiles.has(f)).length.toLocaleString()}/
          {Math.max(files.length, review.totalFilesChanged).toLocaleString()} files viewed
        </span>
        {actions}
      </div>
      {document}
    </div>
  );
}
/** Mount code shortly before it is reached; keep it mounted to retain comments and expansion. */
function PairedSection({
  index,
  title,
  hasCode,
  forceReady,
  narrative,
  code,
  tool,
  layout,
}: {
  layout: ColumnLayout;
  index: number;
  title: string;
  hasCode: boolean;
  forceReady: boolean;
  narrative: ReactNode;
  code: ReactNode;
  tool?: ReactNode;
}) {
  const host = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(forceReady);
  const mounted = ready || forceReady;
  useEffect(() => {
    const element = host.current;
    if (!element || ready) return;
    if (forceReady) {
      setReady(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setReady(true);
          observer.disconnect();
        }
      },
      { root: element.closest('.explanation-document'), rootMargin: '1200px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, forceReady]);
  const column = useCallback(
    (element: HTMLDivElement | null) => (element ? layout.column(index, element) : undefined),
    [layout, index]
  );
  return (
    <section
      ref={host}
      className="explanation-section"
      data-explanation-section={index}
      aria-label={title}
      data-has-code={hasCode || undefined}
      tabIndex={-1}
    >
      <div ref={column} className="explanation-column explanation-section-text">
        {narrative}
      </div>
      {(hasCode || tool) && (
        <div
          ref={column}
          className="explanation-column explanation-section-code"
          role="region"
          aria-label={`Code for ${title}`}
        >
          {hasCode && (
            <div hidden={!!tool}>
              {mounted ? code : <div className="explanation-code-reserve" aria-hidden="true" />}
            </div>
          )}
          {tool && <div className="review-tool-slot">{tool}</div>}
        </div>
      )}
    </section>
  );
}
