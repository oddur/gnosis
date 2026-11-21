// Serves the conflict lab to the conflict gallery (tests/conflict-gallery-browser.ts). Each gallery entry is one step
// of a lab case (tests/fixtures/conflicts, plus a sample of the generated matrix) in its own private bare repository,
// with the real conflict service on top (labRepo in scripts/conflict-lab.mjs). The conflict workspace sends its
// requests here in place of the app's IPC, so preparation, saves and the preview run the real pipeline. Offline.
//
//   tsx scripts/conflict-gallery-server.mjs      prints `conflict-gallery <port>` once it listens on 127.0.0.1
//
// GNOSIS_GALLERY_ONLY=a,b keeps entries whose name contains any of the texts.
//
//   GET  /entries         every entry: id, case, step, description, expectations
//   POST /open?id=…       prepares an entry (and the next one, in the background); returns { url }
//   POST /rpc?id=…        one conflict request (lib/conflict-resolution.ts) through the service; returns the reply
//   POST /close?id=…      removes the entry's repository
import process from 'node:process';
import console from 'node:console';
import http from 'node:http';
import { URL } from 'node:url';
import { caseSteps, labRepo, stepExpectations } from './conflict-lab.mjs';
import { loadCases } from './conflict-lab-lib.mjs';
import { generateMatrix } from './conflict-lab-generate.mjs';

/** One variant per pattern in three languages, a different three for each pattern, so every language shows up. */
export function matrixSample(perPattern = 3) {
  const byPattern = new Map();
  for (const c of generateMatrix({ variants: 1 }))
    (byPattern.get(c.meta.pattern) ?? byPattern.set(c.meta.pattern, []).get(c.meta.pattern)).push(c);
  return [...byPattern.values()].flatMap((list, i) =>
    Array.from({ length: Math.min(perPattern, list.length) }, (_, k) => list[(i + k) % list.length])
  );
}

const fixtures = await loadCases();
const cases = [...fixtures, ...matrixSample().filter((g) => !fixtures.some((c) => c.name === g.name))];
const only = (process.env.GNOSIS_GALLERY_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const entries = cases
  .flatMap((c) => caseSteps(c).map((step) => ({ id: step === 'pr' ? c.name : `${c.name}--${step}`, c, step })))
  .filter((e) => !only.length || only.some((text) => e.id.includes(text)));

const prepared = new Map(); // id -> Promise<{ lab, url }>
function prepare(entry) {
  let value = prepared.get(entry.id);
  if (!value) {
    value = (async () => {
      const lab = await labRepo(entry.c);
      const { url } = await lab.step(entry.step);
      return { lab, url };
    })();
    // A failure is reported when the entry is opened, not as an unhandled rejection while it waits.
    value.catch(() => {});
    prepared.set(entry.id, value);
  }
  return value;
}

const server = http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      // The workbench page is served from another port.
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
    });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'OPTIONS') return reply(204, {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/entries')
      return reply(
        200,
        entries.map(({ id, c, step }) => ({
          id,
          name: c.name,
          step,
          description: c.meta.description ?? '',
          category: c.meta.category ?? '',
          language: c.meta.language ?? '',
          pattern: c.meta.pattern,
          expected: stepExpectations(c, step) ?? {},
          languagesOff: c.meta.languagesOff ?? [],
          mergiraf: c.meta.mergiraf,
        }))
      );
    const index = entries.findIndex((e) => e.id === url.searchParams.get('id'));
    if (index < 0) return reply(404, { error: `No gallery entry ${url.searchParams.get('id')}` });
    const entry = entries[index];
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/open') {
      const { url: prUrl } = await prepare(entry);
      // The next entry builds while the browser shows this one.
      if (entries[index + 1]) void prepare(entries[index + 1]);
      return reply(200, { url: prUrl });
    }
    if (url.pathname === '/rpc') {
      const { lab } = await prepare(entry);
      return reply(200, await lab.run(JSON.parse(body)));
    }
    if (url.pathname === '/close') {
      const value = prepared.get(entry.id);
      prepared.delete(entry.id);
      await value?.then(({ lab }) => lab.cleanup()).catch(() => {});
      return reply(200, {});
    }
    reply(404, { error: `Unknown path ${url.pathname}` });
  } catch (error) {
    reply(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(0, '127.0.0.1', () => console.log(`conflict-gallery ${server.address().port}`));
async function shutdown() {
  server.close();
  await Promise.all([...prepared.values()].map((p) => p.then(({ lab }) => lab.cleanup()).catch(() => {})));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
