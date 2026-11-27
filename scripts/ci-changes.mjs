// Which parts of Checks a change needs (.github/workflows/checks.yml, the `changes` job). It reads the changed paths,
// one per line, from stdin, and prints `app=…`, `site=…` and `extension=…` lines for $GITHUB_OUTPUT.
//
// - app: the desktop app's checks: type check, unit tests, the browser suites and the packages.
// - site: the website build (site/), which Checks runs for pull requests; site.yml builds and deploys it from main.
// - extension: the "Open in Gnosis" browser extension build (extensions/browser). Its unit tests run with the app's
//   (`npm test`), so a change to it runs the app checks too.
//
// A path that matches no rule runs everything: only paths known not to affect a part skip it. The caller runs
// everything when it cannot list the paths.

import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';

/** Documentation and similar: no part's build or tests read them. */
const DOCS = /^(docs\/|\.github\/ISSUE_TEMPLATE\/)|\.md$|(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)([.-][^/]*)?$/;
/** Markdown under these folders can be test data (tests/fixtures/conflicts) or shipped content, so it is not docs. */
const CODE = /^(tests|src|lib|components|scripts|resources|extensions)\//;
/** The website, built on its own. */
const SITE = /^site\//;
/** The extension's own folder. */
const EXTENSION = /^extensions\//;
/** Read by every part's build: a change here runs them all. */
const SHARED =
  /^(package\.json|package-lock\.json|tsconfig\.json|\.github\/workflows\/checks\.yml|scripts\/ci-changes\.mjs)$/;

/**
 * @param {readonly string[]} paths the changed paths (a rename counts under both names)
 * @returns {{ app: boolean; site: boolean; extension: boolean }}
 */
export function classify(paths) {
  const needs = { app: false, site: false, extension: false };
  for (const path of paths) {
    if (!path) continue;
    if (SHARED.test(path)) return { app: true, site: true, extension: true };
    if (SITE.test(path)) needs.site = true;
    else if (EXTENSION.test(path)) needs.extension = needs.app = true;
    else if (DOCS.test(path) && !CODE.test(path)) continue;
    // Anything else is the app, or not known to be safe to skip.
    else needs.app = true;
  }
  return needs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    const paths = input
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // No paths: nothing can be ruled out.
    const needs = paths.length ? classify(paths) : { app: true, site: true, extension: true };
    for (const [part, needed] of Object.entries(needs)) console.log(`${part}=${needed}`);
  });
}
