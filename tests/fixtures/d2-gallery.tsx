import { useState } from 'react';
import { ArrowLeft, ArrowRight, Moon, Sun } from 'lucide-react';
import { D2Diagram } from '../../components/D2Diagram';
import { Button } from '../../components/ui/button';
import { D2_EXAMPLES } from './d2-examples';
import { normalizeD2Diagram } from '../../lib/diagram-spec';
import generated from './d2-generated.json';
const examples = new URLSearchParams(location.search).has('generated')
  ? generated.map((item) => ({ ...item, diagram: normalizeD2Diagram(item.diagram) ?? { source: '' } }))
  : D2_EXAMPLES;
const labels: Record<string, string> = {
  architecture: 'Architecture',
  sequence: 'Sequence',
  change: 'Before & after',
  algorithm: 'Algorithm',
};

/** Throwaway engine evaluation, sharing the real explanation diagram component. */
export function DiagramGallery() {
  const initial = new URLSearchParams(location.search).get('variant');
  const [index, setIndex] = useState(
    Math.max(
      0,
      examples.findIndex((item) => item.id === initial)
    )
  );
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const [source, setSource] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const example = examples[index];
  function choose(next: number) {
    setIndex(next);
    setSource(null);
    setEditing(false);
    const url = new URL(location.href);
    url.searchParams.set('variant', examples[next].id);
    history.replaceState(null, '', url);
  }
  return (
    <main
      className="d2-prototype"
      onKeyDown={(event) => {
        if (
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.defaultPrevented ||
          (event.target as HTMLElement).closest('input,textarea,pre,[contenteditable],[role="dialog"]')
        )
          return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          choose((index + (event.key === 'ArrowLeft' ? examples.length - 1 : 1)) % examples.length);
        }
      }}
    >
      <header className="d2-prototype-header">
        <div>
          <h1>Diagrams that explain the change</h1>
          <p>D2 + TALA · illustrative examples · rendered locally</p>
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
      <nav className="d2-prototype-tabs" aria-label="Diagram examples">
        {examples.map((item, i) => (
          <Button
            key={item.id}
            variant={i === index ? 'secondary' : 'ghost'}
            aria-current={i === index ? 'page' : undefined}
            onClick={() => choose(i)}
          >
            {labels[item.id]}
          </Button>
        ))}
      </nav>
      <section className="d2-prototype-workspace">
        <div className="d2-prototype-context">
          <h2>{example.title}</h2>
          <p>{example.summary}</p>
          <p>{example.diagram.caption}</p>
          <p className="text-muted-foreground">
            Choose a named step to see where to look and why it matters. Expand for more detail; auto-play is optional.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(source ?? example.diagram.source);
              setEditing(!editing);
            }}
          >
            {editing ? 'Close editor' : 'Try your own D2'}
          </Button>
          {editing && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setSource(draft);
              }}
            >
              <label htmlFor="d2-source-editor">Diagram source</label>
              <textarea
                id="d2-source-editor"
                spellCheck={false}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" size="sm">
                Render with TALA
              </Button>
              <p>Bundled icons: gnosis:user, server, database, queue, cloud, shield, code. No network assets.</p>
            </form>
          )}
        </div>
        <div className="d2-prototype-preview">
          <D2Diagram key={example.id} title={example.title} diagram={source === null ? example.diagram : { source }} />
        </div>
      </section>
      <footer className="d2-prototype-switcher">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous example"
          onClick={() => choose((index + examples.length - 1) % examples.length)}
        >
          <ArrowLeft />
        </Button>
        <span>
          {index + 1} / {examples.length} · {labels[example.id]}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next example"
          onClick={() => choose((index + 1) % examples.length)}
        >
          <ArrowRight />
        </Button>
      </footer>
    </main>
  );
}
