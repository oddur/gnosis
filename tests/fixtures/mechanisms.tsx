import architectureGenerated from './architecture-generated.json';
import { EXPLORATION_FIXTURE } from './diagram-exploration';
import { SVG_MOTION_FIXTURE } from './svg-motion';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Moon, Sun } from 'lucide-react';
import { MechanismDiagram } from '../../components/MechanismDiagram';
import { Markdown } from '../../components/Markdown';
import { Button } from '../../components/ui/button';
import { normalizeMechanism } from '../../lib/mechanism';
import { QUEUE_SCENE, MECHANISM_CASES } from './mechanism-examples';
import previousGenerated from './mechanism-generated.json';
import generated from './illustration-generated.json';
import { normalizeSvgIllustration } from '../../lib/svg-illustration';
import { SvgIllustration } from '../../components/SvgIllustration';
import '../../src/globals.css';
import './mechanisms.css';
type Example = {
  id: string;
  title: string;
  code: string;
  files?: Record<string, string | undefined>;
  filePath: string;
  slide: { title?: string; narrative: string; mechanism?: unknown; svgIllustration?: unknown };
};
const fixtures: Example[] = [
  {
    ...MECHANISM_CASES[0],
    slide: {
      title: 'Keep queue order at the weight limit',
      narrative:
        '- Stop when the next item exceeds capacity.\n- Let one oversized item run alone so the queue can advance.',
      mechanism: QUEUE_SCENE,
    },
  },
];
type SourceToken = { content: string; light: string; dark: string };
function useSourceTokens(source: string) {
  const worker = useRef<Worker | null>(null);
  const request = useRef(0);
  const [result, setResult] = useState<{ source: string; tokens: SourceToken[][] } | null>(null);
  useEffect(() => {
    const instance = new Worker(new URL('./gallery-highlight.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = worker.current;
    if (!instance) return;
    const id = ++request.current;
    instance.onmessage = (event: MessageEvent<{ id: number; tokens: SourceToken[][] | null }>) => {
      if (event.data.id === id && event.data.tokens) setResult({ source, tokens: event.data.tokens });
    };
    instance.postMessage({ id, source });
  }, [source]);
  return result?.source === source ? result.tokens : null;
}
function Gallery() {
  const [index, setIndex] = useState(0);
  const [previous, setPrevious] = useState(new URLSearchParams(location.search).has('previous'));
  const architecture = new URLSearchParams(location.search).has('architecture');
  const examples: Example[] = new URLSearchParams(location.search).has('exploration-fixture')
    ? [
        {
          id: 'exploration',
          title: 'Shared reads',
          filePath: 'fixture.ts',
          code: '// caller\n// cache\n// join',
          slide: {
            narrative: 'Inspect components and their direct connections.',
            svgIllustration: EXPLORATION_FIXTURE,
          },
        },
      ]
    : architecture
      ? architectureGenerated
      : new URLSearchParams(location.search).has('motion-fixture')
        ? [
            {
              id: 'motion',
              title: 'Playback test',
              filePath: 'fixture.ts',
              code: '// Authored fixture',
              slide: { narrative: 'Playback fixture', svgIllustration: SVG_MOTION_FIXTURE },
            },
          ]
        : new URLSearchParams(location.search).has('fixtures')
          ? fixtures
          : previous
            ? previousGenerated
            : generated;
  const [dark, setDark] = useState(false);
  const [line, setLine] = useState(0);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  useEffect(() => {
    if (line) document.querySelector(`[data-source-line="${line}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [line, sourcePath]);
  const example = examples.at(index);
  const activePath = sourcePath ?? example?.filePath ?? '';
  const activeCode = example?.files?.[activePath] ?? example?.code ?? '';
  const sourceTokens = useSourceTokens(activeCode);
  const sourceLines = activeCode.split('\n');
  const sourceStart = sourceLines.length > 200 ? Math.max(0, line - 16) : 0;
  const visibleSource = sourceLines.slice(sourceStart, sourceLines.length > 200 ? sourceStart + 100 : undefined);
  const scene = normalizeMechanism(example?.slide.mechanism);
  const illustration = normalizeSvgIllustration(example?.slide.svgIllustration);
  if (!example) return <main>Generate examples with npm run eval:illustrations -- --live.</main>;
  return (
    <main className="mechanism-gallery">
      <header>
        <div>
          <h1>Visual explanations</h1>
          <p>
            {architecture
              ? 'Generated from Gnosis source · Select components to explore'
              : 'Generated from illustrative source code · Gnosis explanation player'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            document.documentElement.classList.toggle('dark', !dark);
            setDark(!dark);
          }}
        >
          {dark ? <Sun /> : <Moon />}
          {dark ? 'Light' : 'Dark'}
        </Button>
      </header>
      {!architecture && (
        <div className="illustration-comparison" role="group" aria-label="Compare visual approaches">
          <Button
            variant={!previous ? 'secondary' : 'ghost'}
            aria-pressed={!previous}
            onClick={() => setPrevious(false)}
          >
            New version
          </Button>
          <Button
            variant={previous ? 'secondary' : 'ghost'}
            aria-pressed={previous}
            disabled={index >= previousGenerated.length}
            onClick={() => setPrevious(true)}
          >
            Previous version
          </Button>
        </div>
      )}
      <nav aria-label="Generated explanations">
        {examples.map((item, i) => (
          <Button
            key={item.id}
            variant={i === index ? 'secondary' : 'ghost'}
            aria-current={i === index ? 'page' : undefined}
            onClick={() => {
              setIndex(i);
              setLine(0);
              setSourcePath(null);
            }}
          >
            {item.title}
          </Button>
        ))}
      </nav>
      <section className="mechanism-gallery-panes">
        <article>
          <h2>{example.slide.title ?? example.title}</h2>
          <Markdown>{example.slide.narrative}</Markdown>
          {illustration ? (
            <>
              <SvgIllustration
                key={`${example.id}-new`}
                illustration={illustration}
                canShowCode={(source) =>
                  (source.filePath === example.filePath || !!example.files?.[source.filePath]) &&
                  source.startLine <= (example.files?.[source.filePath] ?? example.code).split('\n').length
                }
                onShowCode={(source) => {
                  setSourcePath(source.filePath);
                  setLine(source.startLine);
                  document
                    .querySelector(`[data-source-line="${source.startLine}"]`)
                    ?.scrollIntoView({ block: 'nearest' });
                }}
              />
              <details className="illustration-design-choice">
                <summary>Why this visual?</summary>
                <p>{illustration.plan.visualApproach}</p>
                <p>{illustration.plan.whyThisForm}</p>
              </details>
            </>
          ) : scene ? (
            <MechanismDiagram
              key={`${example.id}-old`}
              scene={scene}
              canShowCode={(source) =>
                (source.filePath === example.filePath || !!example.files?.[source.filePath]) &&
                source.startLine <= (example.files?.[source.filePath] ?? example.code).split('\n').length
              }
              onShowCode={(source) => {
                setLine(source.startLine);
                document
                  .querySelector(`[data-source-line="${source.startLine}"]`)
                  ?.scrollIntoView({ block: 'nearest' });
              }}
            />
          ) : (
            <p>The model did not produce a valid illustration for this topic.</p>
          )}
        </article>
        <aside>
          <h2>{activePath}</h2>
          <p>{architecture ? 'Source snapshot used for generation' : 'Illustrative source used for generation'}</p>
          <pre>
            <code>
              {visibleSource.map((text, offset) => {
                const i = sourceStart + offset;
                return (
                  <span key={i} data-source-line={i + 1} data-selected={line === i + 1}>
                    <span className="gallery-line-number" aria-hidden="true">
                      {i + 1}
                    </span>
                    {sourceTokens?.[i]?.map((token, j) => (
                      <span
                        key={j}
                        className="gallery-source-token"
                        style={{ '--source-light': token.light, '--source-dark': token.dark } as CSSProperties}
                      >
                        {token.content}
                      </span>
                    )) ?? text}
                    {'\n'}
                  </span>
                );
              })}
            </code>
          </pre>
        </aside>
      </section>
    </main>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Gallery />);
