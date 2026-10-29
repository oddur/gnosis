import { SVG_MOTION_FIXTURE } from './svg-motion';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
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
function Gallery() {
  const [index, setIndex] = useState(0);
  const [previous, setPrevious] = useState(new URLSearchParams(location.search).has('previous'));
  const examples: Example[] = new URLSearchParams(location.search).has('motion-fixture')
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
  const example = examples.at(index);
  const scene = normalizeMechanism(example?.slide.mechanism);
  const illustration = normalizeSvgIllustration(example?.slide.svgIllustration);
  if (!example) return <main>Generate examples with npm run eval:illustrations -- --live.</main>;
  return (
    <main className="mechanism-gallery">
      <header>
        <div>
          <h1>Visual explanations</h1>
          <p>Generated from illustrative source code · Gnosis explanation player</p>
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
      <div className="illustration-comparison" role="group" aria-label="Compare visual approaches">
        <Button variant={!previous ? 'secondary' : 'ghost'} aria-pressed={!previous} onClick={() => setPrevious(false)}>
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
      <nav aria-label="Generated explanations">
        {examples.map((item, i) => (
          <Button
            key={item.id}
            variant={i === index ? 'secondary' : 'ghost'}
            aria-current={i === index ? 'page' : undefined}
            onClick={() => {
              setIndex(i);
              setLine(0);
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
                  source.filePath === example.filePath && source.startLine <= example.code.split('\n').length
                }
                onShowCode={(source) => {
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
                source.filePath === example.filePath && source.startLine <= example.code.split('\n').length
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
          <h2>{example.filePath}</h2>
          <p>Illustrative source used for generation</p>
          <pre>
            <code>
              {example.code.split('\n').map((text, i) => (
                <span key={i} data-source-line={i + 1} data-selected={line === i + 1}>
                  <span aria-hidden="true">{i + 1}</span>
                  {text}
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
        </aside>
      </section>
    </main>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Gallery />);
