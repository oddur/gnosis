import { useState } from 'react';
import { ArrowLeft, ArrowRight, Moon, Sun } from 'lucide-react';
import { D2Diagram } from '../../components/D2Diagram';
import { Button } from '../../components/ui/button';
import { D2_EXAMPLES } from '../../lib/d2-prototype-examples';

/** Throwaway engine evaluation, sharing the real explanation diagram component. */
export function D2PrototypePage() {
  const initial = new URLSearchParams(location.search).get('variant');
  const [index, setIndex] = useState(
    Math.max(
      0,
      D2_EXAMPLES.findIndex((item) => item.id === initial)
    )
  );
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const [source, setSource] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const example = D2_EXAMPLES[index];
  function choose(next: number) {
    setIndex(next);
    setSource(null);
    setEditing(false);
    const url = new URL(location.href);
    url.searchParams.set('variant', D2_EXAMPLES[next].id);
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
          choose((index + (event.key === 'ArrowLeft' ? 2 : 1)) % 3);
        }
      }}
    >
      <header className="d2-prototype-header">
        <div>
          <h1>Diagrams that explain the change</h1>
          <p>D2 + TALA prototype · illustrative examples · rendered locally</p>
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
        {D2_EXAMPLES.map((item, i) => (
          <Button
            key={item.id}
            variant={i === index ? 'secondary' : 'ghost'}
            aria-current={i === index ? 'page' : undefined}
            onClick={() => choose(i)}
          >
            {['Architecture', 'Sequence', 'Before & after'][i]}
          </Button>
        ))}
      </nav>
      <section className="d2-prototype-workspace">
        <div className="d2-prototype-context">
          <h2>{example.title}</h2>
          <p>{example.summary}</p>
          <p>{example.diagram.caption}</p>
          <p className="text-muted-foreground">
            Expand to inspect the layout and annotations. Playback follows the change at your pace; animation stays off
            until you choose it.
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
        <Button variant="ghost" size="icon-sm" aria-label="Previous example" onClick={() => choose((index + 2) % 3)}>
          <ArrowLeft />
        </Button>
        <span>
          {index + 1} / 3 · {['Architecture', 'Sequence', 'Before & after'][index]}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next example" onClick={() => choose((index + 1) % 3)}>
          <ArrowRight />
        </Button>
      </footer>
    </main>
  );
}
