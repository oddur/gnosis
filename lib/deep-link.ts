/**
 * "Open Gnosis at this exact place", shared by notifications (#307), the menu bar (#308) and `gnosis://` links (#309).
 * Pure, with no Node or Electron imports. Targets hold identifiers only: no titles, queue items or SHAs except the
 * optional link SHA.
 *
 * This module is the only place the URL grammar exists (design section 3): `parseDeepLink` reads a `gnosis://`
 * string, `parseGitHubUrl` maps a GitHub page URL (table 3.4), `formatDeepLink` is the only producer, and
 * `parseDeepLinkTarget` re-validates a target that crossed IPC. Syntax is strict; lookups are the renderer's job.
 */
import type { AppLocation, WorkspaceTab } from './navigation-history';

export const DEEP_LINK_VERSION = 1;
/** `notes` is the internal `brief` tab. */
export type PrTab = 'summary' | 'changes' | 'commits' | 'checks' | 'feedback' | 'explanation' | 'notes';
export const PR_TABS: readonly PrTab[] = ['summary', 'changes', 'commits', 'checks', 'feedback', 'explanation', 'notes'];
/** `host` is `github.com` in version 1. GitHub Enterprise would add hosts here, not change the grammar. */
export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}
export interface FileLocator {
  /** Repository-relative path, from a gnosis link. Only ever compared to the PR's changed paths. */
  path?: string;
  /** 64 hex: SHA-256 of the path, from a GitHub `#diff-` anchor. */
  anchor?: string;
  line?: number;
  endLine?: number;
  side?: 'before' | 'after';
  /** 40 hex head SHA the link was made at; absent means latest. */
  sha?: string;
}
export interface LinkFilters {
  repo?: string;
  author?: string;
  branch?: string;
  query?: string;
  status?: 'ready' | 'draft';
  read?: 'unread' | 'read';
  kind?: 'pr' | 'stack';
}
export type QueueSection = 'all' | 'response' | 'requested' | 'updated' | 'stacks' | 'saved' | 'starred' | 'muted';
export const QUEUE_SECTIONS: readonly QueueSection[] = ['all', 'response', 'requested', 'updated', 'stacks', 'saved', 'starred', 'muted'];
export type LinkSettingsSection = 'queue' | 'repositories' | 'review' | 'appearance' | 'notifications' | 'integrations';
export const SETTINGS_SECTIONS: readonly LinkSettingsSection[] = ['queue', 'repositories', 'review', 'appearance', 'notifications', 'integrations'];

export type DeepLinkTarget =
  | { kind: 'queue'; section?: QueueSection; view?: string; filters?: LinkFilters }
  | {
      kind: 'pr';
      pr: PrRef;
      scope?: 'stack';
      tab?: PrTab;
      file?: FileLocator;
      threadId?: string;
      commentId?: string;
      commit?: string;
      check?: string;
      slide?: string;
    }
  | { kind: 'conflicts'; pr: PrRef }
  | { kind: 'review'; reviewId: string; slide?: string; file?: FileLocator; threadId?: string }
  | { kind: 'settings'; section?: LinkSettingsSection }
  | { kind: 'activity' }
  | { kind: 'commit'; host: string; owner: string; repo: string; sha: string; file?: FileLocator }
  | { kind: 'compare'; host: string; owner: string; repo: string; base?: string; head: string; headOwner?: string; file?: FileLocator };
export type PrLinkTarget = Extract<DeepLinkTarget, { kind: 'pr' }>;

/** `notification`, `menubar` and `tray` targets are built by Gnosis and are trusted. */
export type DeepLinkSource = 'os' | 'content' | 'notification' | 'menubar' | 'tray';
export const TRUSTED_SOURCES: readonly DeepLinkSource[] = ['notification', 'menubar', 'tray'];
export const DEEP_LINK_SOURCES: readonly DeepLinkSource[] = ['os', 'content', 'notification', 'menubar', 'tray'];

export const DEEP_LINK_ROUTES = ['open', 'pr', 'stack', 'conflicts', 'queue', 'review', 'settings', 'activity'] as const;
export type DeepLinkRoute = (typeof DEEP_LINK_ROUTES)[number];
export type DeepLinkErrorCode =
  | 'malformed'
  | 'too-long'
  | 'unknown-route'
  | 'bad-parameter'
  | 'unsupported-version'
  | 'unsupported-host'
  | 'unsupported-url'
  | 'rate-limited';
export const DEEP_LINK_ERROR_CODES: readonly DeepLinkErrorCode[] = [
  'malformed', 'too-long', 'unknown-route', 'bad-parameter', 'unsupported-version', 'unsupported-host', 'unsupported-url', 'rate-limited',
];
/** `route` is only ever an allow-listed route word, never input. `count` is how many links a rate limit dropped. */
export type DeepLinkError = { code: DeepLinkErrorCode; route?: DeepLinkRoute; count?: number };

// ── Limits and patterns (design section 7.1) ──

export const DEEP_LINK_HOSTS: readonly string[] = ['github.com'];
export const DEEP_LINK_MAX_LENGTH = 4096;
export const DEEP_LINK_MAX_PARAMETERS = 16;
const VALUE_MAX = 512;
const VALUE_LIMITS: Record<string, number> = { file: 1024, q: 200, url: 2000 };
const GITHUB_URL_MAX = 2000;

// GitHub logins are letters, digits and hyphens; managed (EMU) logins add an `_shortcode` suffix.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REPO = /^[\w.-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,8}$/;
const LINE = /^([1-9]\d{0,6})(?:-([1-9]\d{0,6}))?$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const ANCHOR = /^[0-9a-f]{64}$/;
const NUMERIC_ID = /^[1-9]\d{0,19}$/;
const KEY = /^[\w.:=-]{1,200}$/;
const VIEW = /^[\w.:= -]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Targets built by Gnosis (notifications, the tray) may name local reviews, whose ids are not UUIDs. */
const TRUSTED_REVIEW_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** C0 and C1 controls (NUL and DEL included), backslash, and bidi controls. Checked before and after decoding. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const safe = (text: string) => !UNSAFE.test(text);

const validRepo = (repo: string) => REPO.test(repo) && repo !== '.' && repo !== '..';
const validPr = (owner: string, repo: string, number: string) => OWNER.test(owner) && validRepo(repo) && NUMBER.test(number);

/** Relative, no leading `/`, no empty, `.` or `..` segment, no `:` in the first segment. */
export function validFilePath(path: string): boolean {
  if (!path || path.length > VALUE_LIMITS.file || !safe(path) || path.startsWith('/')) return false;
  const segments = path.split('/');
  if (segments[0].includes(':')) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The git ref-name rules (`git check-ref-format`), at most 255 characters. */
export function validRefName(ref: string): boolean {
  if (!ref || ref.length > 255 || !safe(ref) || ref === '@') return false;
  if (/[\s~^:?*[\]]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false;
  return ref.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

function decodeOnce(text: string, plus = false): string | undefined {
  try {
    return decodeURIComponent(plus ? text.replace(/\+/g, ' ') : text);
  } catch {
    return undefined;
  }
}

// ── Building targets ──

export function prRef(url: string): PrRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([^/]+)$/.exec(url);
  return match && validPr(match[1], match[2], match[3])
    ? { host: 'github.com', owner: match[1], repo: match[2], number: Number(match[3]) }
    : undefined;
}
export const prUrl = (ref: PrRef) => `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
export function prTarget(url: string, tab?: PrTab): DeepLinkTarget | undefined {
  const pr = prRef(url);
  return pr ? { kind: 'pr', pr, ...(tab ? { tab } : {}) } : undefined;
}

/** The Gnosis links for GitHub PR URLs, one per PR. Local reviews and other URLs have none. */
export function prDeepLinks(urls: readonly string[], scheme = 'gnosis'): string[] {
  return urls.flatMap((url) => {
    const target = prTarget(url);
    return target ? [formatDeepLink(target, scheme)] : [];
  });
}

type LocatorKey = 'file' | 'threadId' | 'commentId' | 'commit' | 'check' | 'slide';
type Locators = Pick<PrLinkTarget, 'tab' | LocatorKey>;
/** Which tabs each locator applies to. A locator on another tab is dropped. */
const APPLIES: Record<LocatorKey, readonly PrTab[]> = {
  file: ['changes', 'commits'],
  threadId: ['feedback', 'changes'],
  commentId: ['feedback', 'changes'],
  commit: ['commits'],
  check: ['checks'],
  slide: ['explanation'],
};
/** A locator implies its tab when none is given, in this order. */
const IMPLIED: [LocatorKey, PrTab][] = [
  ['file', 'changes'],
  ['threadId', 'feedback'],
  ['commentId', 'feedback'],
  ['commit', 'commits'],
  ['check', 'checks'],
  ['slide', 'explanation'],
];
/** The PR target for a tab and locators: the tab is implied when missing, `summary` is the default, and locators
 * that do not apply to the tab are dropped. */
function prWith(pr: PrRef, scope: 'stack' | undefined, locators: Locators): PrLinkTarget {
  const tab = locators.tab ?? IMPLIED.find(([key]) => locators[key] !== undefined)?.[1];
  const target: PrLinkTarget = { kind: 'pr', pr, ...(scope ? { scope } : {}) };
  if (!tab || tab === 'summary') return target;
  target.tab = tab;
  for (const [key] of IMPLIED) {
    const value = locators[key];
    if (value === undefined || !APPLIES[key].includes(tab)) continue;
    // A file on the Commits tab belongs to the selected commit.
    if (key === 'file' && tab === 'commits' && !locators.commit) continue;
    (target as Record<LocatorKey, unknown>)[key] = value;
  }
  return target;
}

// ── Parsing a gnosis:// link ──

type Parameters = Map<string, string>;
/** Array elements and regex groups that may be missing; the project does not check indexed access. */
type Maybe = string | undefined;
type Result<T> = { value: T } | { error: DeepLinkErrorCode };
const fail = (error: DeepLinkErrorCode): { error: DeepLinkErrorCode } => ({ error });

function parseQuery(query: string | undefined): Result<Parameters> {
  const parameters: Parameters = new Map();
  if (!query) return { value: parameters };
  for (const part of query.split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const key = decodeOnce(index < 0 ? part : part.slice(0, index), true);
    const value = decodeOnce(index < 0 ? '' : part.slice(index + 1), true);
    if (key === undefined || value === undefined) return fail('malformed');
    if (!safe(key) || !safe(value)) return fail('bad-parameter');
    if (parameters.has(key)) return fail('bad-parameter');
    if (value.length > (VALUE_LIMITS[key] ?? VALUE_MAX)) return fail('too-long');
    parameters.set(key, value);
    if (parameters.size > DEEP_LINK_MAX_PARAMETERS) return fail('bad-parameter');
  }
  return { value: parameters };
}

function fileLocator(parameters: Parameters, review = false): Result<FileLocator | undefined> {
  const path = parameters.get('file');
  const anchor = review ? undefined : parameters.get('anchor');
  const line = parameters.get('line');
  const side = parameters.get('side');
  const sha = review ? undefined : parameters.get('sha');
  if (path !== undefined && !validFilePath(path)) return fail('bad-parameter');
  if (anchor !== undefined && !ANCHOR.test(anchor)) return fail('bad-parameter');
  const lines = line === undefined ? null : LINE.exec(line);
  const end = lines?.[2] as Maybe;
  if (line !== undefined && (!lines || (end !== undefined && Number(end) < Number(lines[1])))) return fail('bad-parameter');
  if (side !== undefined && side !== 'before' && side !== 'after') return fail('bad-parameter');
  if (sha !== undefined && sha !== 'latest' && !SHA40.test(sha)) return fail('bad-parameter');
  // `line`, `side` and `sha` only mean something with a file.
  if (path === undefined && anchor === undefined) return { value: undefined };
  const file: FileLocator = {};
  if (path !== undefined) file.path = path;
  if (anchor !== undefined) file.anchor = anchor;
  if (lines) {
    file.line = Number(lines[1]);
    if (end !== undefined && end !== lines[1]) file.endLine = Number(end);
  }
  if (side === 'before') file.side = 'before';
  if (sha !== undefined && sha !== 'latest') file.sha = sha;
  return { value: file };
}

const LOCATOR_PARAMETERS: [Exclude<LocatorKey, 'file'>, string, RegExp][] = [
  ['threadId', 'thread', KEY],
  ['commentId', 'comment', NUMERIC_ID],
  ['commit', 'commit', SHA],
  ['check', 'check', NUMERIC_ID],
  ['slide', 'slide', KEY],
];
function prLocators(parameters: Parameters, tabParameter: boolean): Result<Locators> {
  const file = fileLocator(parameters);
  if ('error' in file) return file;
  const locators: Locators = {};
  if (file.value) locators.file = file.value;
  for (const [key, name, pattern] of LOCATOR_PARAMETERS) {
    const value = parameters.get(name);
    if (value === undefined) continue;
    if (!pattern.test(value)) return fail('bad-parameter');
    locators[key] = value;
  }
  const tab = tabParameter ? parameters.get('tab') : undefined;
  if (tab !== undefined) {
    if (!PR_TABS.includes(tab as PrTab)) return fail('bad-parameter');
    locators.tab = tab as PrTab;
  }
  return { value: locators };
}

function linkFilters(parameters: Parameters): Result<LinkFilters | undefined> {
  const filters: LinkFilters = {};
  const repo = parameters.get('repo');
  if (repo !== undefined) {
    const [owner = '', name, ...rest] = repo.split('/') as Maybe[];
    if (rest.length || name === undefined || !OWNER.test(owner) || !validRepo(name)) return fail('bad-parameter');
    filters.repo = repo;
  }
  const author = parameters.get('author');
  if (author !== undefined) {
    if (!OWNER.test(author)) return fail('bad-parameter');
    filters.author = author;
  }
  const branch = parameters.get('branch');
  if (branch !== undefined) {
    if (!validRefName(branch)) return fail('bad-parameter');
    filters.branch = branch;
  }
  const status = parameters.get('status');
  if (status !== undefined) {
    if (status !== 'ready' && status !== 'draft') return fail('bad-parameter');
    filters.status = status;
  }
  const read = parameters.get('read');
  if (read !== undefined) {
    if (read !== 'unread' && read !== 'read') return fail('bad-parameter');
    filters.read = read;
  }
  const kind = parameters.get('kind');
  if (kind !== undefined) {
    if (kind !== 'pr' && kind !== 'stack') return fail('bad-parameter');
    filters.kind = kind;
  }
  const query = parameters.get('q');
  if (query !== undefined) filters.query = query;
  return { value: Object.keys(filters).length ? filters : undefined };
}

function parseRoute(route: DeepLinkRoute, segments: string[], parameters: Parameters, hosts: readonly string[]): Result<DeepLinkTarget> {
  if (route === 'pr' || route === 'stack' || route === 'conflicts') {
    const [owner = '', repo = '', number, tab, ...rest] = segments as Maybe[];
    if (rest.length || number === undefined || (route === 'conflicts' && tab !== undefined)) return fail('malformed');
    if (!validPr(owner, repo, number)) return fail('bad-parameter');
    const pr: PrRef = { host: 'github.com', owner, repo, number: Number(number) };
    if (route === 'conflicts') return { value: { kind: 'conflicts', pr } };
    if (tab !== undefined && !PR_TABS.includes(tab as PrTab)) return fail('bad-parameter');
    // On `pr` and `stack` the tab is a path segment, not a parameter.
    const locators = prLocators(parameters, false);
    if ('error' in locators) return locators;
    return { value: prWith(pr, route === 'stack' ? 'stack' : undefined, { ...locators.value, ...(tab ? { tab: tab as PrTab } : {}) }) };
  }
  if (route === 'open') {
    if (segments.length) return fail('malformed');
    const url = parameters.get('url');
    if (url === undefined) return fail('bad-parameter');
    const page = githubPage(url, hosts);
    if ('error' in page) return page;
    const locators = prLocators(parameters, true);
    if ('error' in locators) return locators;
    if (page.value.kind !== 'pr') return page;
    // Other parameters override what the URL implies.
    const { pr, scope, tab, file, threadId, commentId, commit, check, slide } = page.value;
    const implied: Locators = { tab, file, threadId, commentId, commit, check, slide };
    const explicit = Object.keys(locators.value).length > 0;
    return { value: prWith(pr, scope, explicit ? { ...implied, ...locators.value } : implied) };
  }
  if (route === 'queue') {
    if (segments.length) return fail('malformed');
    const target: Extract<DeepLinkTarget, { kind: 'queue' }> = { kind: 'queue' };
    const section = parameters.get('section');
    if (section !== undefined) {
      if (!QUEUE_SECTIONS.includes(section as QueueSection)) return fail('bad-parameter');
      target.section = section as QueueSection;
    }
    const view = parameters.get('view');
    if (view !== undefined) {
      if (!VIEW.test(view)) return fail('bad-parameter');
      target.view = view;
    }
    const filters = linkFilters(parameters);
    if ('error' in filters) return filters;
    if (filters.value) {
      // A saved view and filters are exclusive.
      if (view !== undefined) return fail('bad-parameter');
      target.filters = filters.value;
    }
    return { value: target };
  }
  if (route === 'review') {
    const [reviewId, ...rest] = segments as Maybe[];
    if (reviewId === undefined || rest.length) return fail('malformed');
    if (!UUID.test(reviewId)) return fail('bad-parameter');
    const target: Extract<DeepLinkTarget, { kind: 'review' }> = { kind: 'review', reviewId };
    const slide = parameters.get('slide');
    const thread = parameters.get('thread');
    if ((slide !== undefined && !KEY.test(slide)) || (thread !== undefined && !KEY.test(thread))) return fail('bad-parameter');
    const file = fileLocator(parameters, true);
    if ('error' in file) return file;
    if (slide !== undefined) target.slide = slide;
    if (file.value) target.file = file.value;
    if (thread !== undefined) target.threadId = thread;
    return { value: target };
  }
  if (route === 'settings') {
    const [section, ...rest] = segments as Maybe[];
    if (rest.length) return fail('malformed');
    if (section === undefined) return { value: { kind: 'settings' } };
    if (!SETTINGS_SECTIONS.includes(section as LinkSettingsSection)) return fail('bad-parameter');
    return { value: { kind: 'settings', section: section as LinkSettingsSection } };
  }
  return segments.length ? fail('malformed') : { value: { kind: 'activity' } };
}

/**
 * Parses an untrusted `gnosis://` string into one target, or the reason it was refused. Unknown parameters are
 * ignored, so newer links open in older builds; a known parameter with a bad value, or any repeated parameter,
 * refuses the whole link. `schemes` is `['gnosis']` when packaged and `['gnosis-dev']` in development.
 */
export function parseDeepLink(raw: string, schemes: readonly string[]): { target: DeepLinkTarget } | { error: DeepLinkError } {
  if (typeof raw !== 'string') return { error: { code: 'malformed' } };
  if (raw.length > DEEP_LINK_MAX_LENGTH) return { error: { code: 'too-long' } };
  if (!safe(raw)) return { error: { code: 'malformed' } };
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^?#]*)(?:\?([^#]*))?(#[^]*)?$/.exec(raw);
  // Only the scheme is compared case-insensitively.
  if (!match || !schemes.includes(match[1].toLowerCase())) return { error: { code: 'malformed' } };
  const segments = match[2].split('/');
  // One trailing slash is allowed.
  if (segments.length > 1 && segments.at(-1) === '') segments.pop();
  const word = segments.shift() ?? '';
  // Route words are lower case only, and are never echoed when unknown.
  if (!(DEEP_LINK_ROUTES as readonly string[]).includes(word)) return { error: { code: 'unknown-route' } };
  const route = word as DeepLinkRoute;
  const failed = (code: DeepLinkErrorCode) => ({ error: { code, route } });
  // A fragment on the gnosis link itself is refused; fragments inside `url=` are read.
  const fragment = match[4] as Maybe;
  if (fragment !== undefined) return failed('malformed');
  const decoded: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return failed('bad-parameter');
    const value = decodeOnce(segment);
    if (value === undefined) return failed('malformed');
    if (!value || value === '.' || value === '..' || value.includes('/') || !safe(value)) return failed('bad-parameter');
    decoded.push(value);
  }
  const parameters = parseQuery(match[3]);
  if ('error' in parameters) return failed(parameters.error);
  const version = parameters.value.get('v');
  if (version !== undefined && version !== String(DEEP_LINK_VERSION)) return failed('unsupported-version');
  const result = parseRoute(route, decoded, parameters.value, DEEP_LINK_HOSTS);
  return 'error' in result ? failed(result.error) : { target: result.value };
}

// ── GitHub page URLs (table 3.4) ──

function githubFragment(hash: string): Pick<Locators, 'file' | 'commentId'> {
  const text = hash.replace(/^#/, '');
  const diff = /^diff-([0-9a-f]{64})(?:([LR])([1-9]\d{0,6})(?:-([LR])([1-9]\d{0,6}))?)?$/.exec(text);
  if (diff) {
    const file: FileLocator = { anchor: diff[1] };
    if (diff[3]) {
      file.line = Number(diff[3]);
      if (diff[2] === 'L') file.side = 'before';
      // A range that mixes sides keeps the first line.
      if (diff[5] && diff[4] === diff[2] && Number(diff[5]) > file.line) file.endLine = Number(diff[5]);
    }
    return { file };
  }
  const comment = /^(?:discussion_r|r|issuecomment-|pullrequestreview-)(\d+)$/.exec(text);
  if (comment && NUMERIC_ID.test(comment[1])) return { commentId: comment[1] };
  // `#commitcomment-…`, `#issue-…`, `#partial-pull-merging` and the rest are ignored.
  return {};
}

function compareSpec(spec: string): { base?: string; head: string; headOwner?: string } | undefined {
  let base: string | undefined;
  let head = spec;
  // Ref names cannot contain `..`, so the first `...` or `..` splits base from head.
  const three = spec.indexOf('...');
  const two = spec.indexOf('..');
  if (three >= 0) [base, head] = [spec.slice(0, three), spec.slice(three + 3)];
  else if (two >= 0) [base, head] = [spec.slice(0, two), spec.slice(two + 2)];
  let headOwner: string | undefined;
  const colon = head.indexOf(':');
  if (colon >= 0) [headOwner, head] = [head.slice(0, colon), head.slice(colon + 1)];
  if ((base !== undefined && !validRefName(base)) || !validRefName(head) || (headOwner !== undefined && !OWNER.test(headOwner))) return undefined;
  return { ...(base !== undefined ? { base } : {}), head, ...(headOwner !== undefined ? { headOwner } : {}) };
}

function githubPage(raw: string, hosts: readonly string[]): Result<DeepLinkTarget> {
  if (typeof raw !== 'string' || raw.length > GITHUB_URL_MAX || !safe(raw)) return fail('unsupported-url');
  // Read the authority from the text: `new URL` hides a default port, and user info must be refused.
  const authority = /^https:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (authority === undefined || authority.includes('@') || authority.includes(':')) return fail('unsupported-url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('unsupported-url');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return fail('unsupported-url');
  // Exact host match: no subdomains, no trailing dot, no look-alikes or punycode.
  if (!hosts.includes(url.hostname)) return fail('unsupported-host');
  const host = url.hostname;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
  const segments: string[] = [];
  for (const part of path.slice(1).split('/')) {
    const value = decodeOnce(part);
    if (value === undefined || !safe(value)) return fail('unsupported-url');
    segments.push(value);
  }
  const fragment = githubFragment(url.hash);
  const [owner, repo, page, ...rest] = segments as Maybe[];

  if (owner === 'pulls' && segments.length <= 2) {
    const which = segments[1] as Maybe;
    if (which === undefined || which === 'assigned' || which === 'mentioned') return { value: { kind: 'queue' } };
    if (which === 'review-requested') return { value: { kind: 'queue', section: 'requested' } };
    return fail('unsupported-url');
  }
  if (!owner || !repo || !OWNER.test(owner) || !validRepo(repo)) return fail('unsupported-url');
  if (page === 'pulls' && !rest.length) return { value: { kind: 'queue', filters: { repo: `${owner}/${repo}` } } };
  const sha = rest.length === 1 ? rest[0] : undefined;
  if (page === 'commit' && sha !== undefined && SHA.test(sha))
    return { value: { kind: 'commit', host, owner, repo, sha, ...(fragment.file ? { file: fragment.file } : {}) } };
  if (page === 'compare' && rest.length) {
    // Refs may contain `/`, so the whole spec after `/compare/` is decoded once.
    const encoded = path.slice(`/${owner}/${repo}/compare/`.length);
    const spec = decodeOnce(encoded);
    const compare = spec === undefined || !safe(spec) ? undefined : compareSpec(spec);
    if (!compare) return fail('unsupported-url');
    return { value: { kind: 'compare', host, owner, repo, ...compare, ...(fragment.file ? { file: fragment.file } : {}) } };
  }
  if (page === 'actions') {
    const [runs, run, job, jobId, ...extra] = rest;
    const number = url.searchParams.get('pr') ?? '';
    const shape = runs === 'runs' && NUMERIC_ID.test(run ?? '') && !extra.length && (job === undefined || (job === 'job' && NUMERIC_ID.test(jobId ?? '')));
    if (!shape || !NUMBER.test(number)) return fail('unsupported-url');
    return { value: { kind: 'pr', pr: { host, owner, repo, number: Number(number) }, tab: 'checks' } };
  }
  const [number = '', view, revision, ...more] = rest;
  if (page !== 'pull' || !NUMBER.test(number)) return fail('unsupported-url');
  const pr: PrRef = { host, owner, repo, number: Number(number) };
  if (more.length) return fail('unsupported-url');
  const locators: Locators = { ...fragment };
  if (view === undefined) {
    // The Conversation tab: a comment fragment lands on Feedback.
    if (fragment.commentId) locators.tab = 'feedback';
    delete locators.file;
  } else if (view === 'files' || view === 'changes') {
    if (revision === undefined) locators.tab = 'changes';
    else if (SHA.test(revision)) {
      locators.tab = 'commits';
      locators.commit = revision;
    } else if (/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(revision)) locators.tab = 'changes';
    else return fail('unsupported-url');
  } else if (view === 'commits' && (revision === undefined || SHA.test(revision))) {
    locators.tab = 'commits';
    if (revision) locators.commit = revision;
  } else if (view === 'checks' && revision === undefined) {
    locators.tab = 'checks';
    const check = url.searchParams.get('check_run_id');
    if (check && NUMERIC_ID.test(check)) locators.check = check;
  } else if (view === 'conflicts' && revision === undefined) {
    return { value: { kind: 'conflicts', pr } };
  } else return fail('unsupported-url');
  return { value: prWith(pr, undefined, locators) };
}

/**
 * Maps a raw GitHub page URL (pasted, `open?url=`, or the browser extension) to a target. `https` only, an exact
 * host in `hosts`, no user info, no port. The path is strict; unlisted query parameters and fragments are ignored.
 */
export function parseGitHubUrl(raw: string, hosts: readonly string[] = DEEP_LINK_HOSTS): DeepLinkTarget | undefined {
  const result = githubPage(raw, hosts);
  return 'error' in result ? undefined : result.value;
}

// ── Producing links ──

const encodeValue = (value: string) => encodeURIComponent(value).replace(/%2F/g, '/');
function query(entries: [string, string | number | undefined][]): string {
  const parts = entries
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeValue(String(value))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
function fileEntries(file: FileLocator | undefined): [string, string | number | undefined][] {
  if (!file) return [];
  return [
    ['file', file.path],
    ['anchor', file.anchor],
    ['line', file.line === undefined ? undefined : file.endLine !== undefined ? `${file.line}-${file.endLine}` : file.line],
    ['side', file.side === 'before' ? 'before' : undefined],
    ['sha', file.sha],
  ];
}

/**
 * The canonical link for a target, and the only producer. It emits the `pr/owner/repo/n` form, omits defaults
 * and percent-encodes values, so `parseDeepLink(formatDeepLink(t))` deep-equals `t`. Commit and compare targets
 * have no route of their own and use `open?url=` with the rebuilt GitHub URL.
 */
export function formatDeepLink(target: DeepLinkTarget, scheme = 'gnosis'): string {
  const base = `${scheme}://`;
  const segment = encodeURIComponent;
  switch (target.kind) {
    case 'pr': {
      const { owner, repo, number } = target.pr;
      return `${base}${target.scope === 'stack' ? 'stack' : 'pr'}/${segment(owner)}/${segment(repo)}/${number}${target.tab ? `/${target.tab}` : ''}${query([
        ...fileEntries(target.file),
        ['thread', target.threadId],
        ['comment', target.commentId],
        ['commit', target.commit],
        ['check', target.check],
        ['slide', target.slide],
      ])}`;
    }
    case 'conflicts':
      return `${base}conflicts/${segment(target.pr.owner)}/${segment(target.pr.repo)}/${target.pr.number}`;
    case 'queue':
      return `${base}queue${query([
        ['section', target.section],
        ['view', target.view],
        ['repo', target.filters?.repo],
        ['author', target.filters?.author],
        ['branch', target.filters?.branch],
        ['status', target.filters?.status],
        ['read', target.filters?.read],
        ['kind', target.filters?.kind],
        ['q', target.filters?.query],
      ])}`;
    case 'review':
      return `${base}review/${segment(target.reviewId)}${query([['slide', target.slide], ...fileEntries(target.file), ['thread', target.threadId]])}`;
    case 'settings':
      return `${base}settings${target.section ? `/${target.section}` : ''}`;
    case 'activity':
      return `${base}activity`;
    case 'commit':
    case 'compare':
      return `${base}open?url=${encodeURIComponent(githubUrl(target) ?? '')}`;
  }
}

function diffFragment(file: FileLocator | undefined): string {
  if (!file?.anchor) return '';
  if (file.line === undefined) return `#diff-${file.anchor}`;
  const side = file.side === 'before' ? 'L' : 'R';
  return `#diff-${file.anchor}${side}${file.line}${file.endLine !== undefined ? `-${side}${file.endLine}` : ''}`;
}
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** A GitHub URL rebuilt from the parsed fields, never from the input, for "Open on GitHub". */
export function githubUrl(target: DeepLinkTarget): string | undefined {
  const origin = 'https://github.com';
  switch (target.kind) {
    case 'pr': {
      const base = prUrl({ ...target.pr, host: 'github.com' });
      if (target.tab === 'changes') return `${base}/files`;
      if (target.tab === 'commits') return target.commit ? `${base}/commits/${target.commit}` : `${base}/commits`;
      if (target.tab === 'checks') return target.check ? `${base}/checks?check_run_id=${target.check}` : `${base}/checks`;
      return base;
    }
    case 'conflicts':
      return prUrl({ ...target.pr, host: 'github.com' });
    case 'commit':
      return `${origin}/${target.owner}/${target.repo}/commit/${target.sha}${diffFragment(target.file)}`;
    case 'compare': {
      const head = `${target.headOwner ? `${target.headOwner}:` : ''}${refPath(target.head)}`;
      return `${origin}/${target.owner}/${target.repo}/compare/${target.base !== undefined ? `${refPath(target.base)}...` : ''}${head}${diffFragment(target.file)}`;
    }
    case 'queue':
      if (target.filters?.repo) return `${origin}/${target.filters.repo}/pulls`;
      return target.section === 'requested' ? `${origin}/pulls/review-requested` : `${origin}/pulls`;
    default:
      return undefined;
  }
}

const linkTab = (tab: WorkspaceTab): PrTab => (tab === 'brief' ? 'notes' : tab);
/** The link to a workspace tab's recorded place: a PR on its tab, a saved review, or a queue section or view. */
export function targetFromLocation(location: AppLocation): DeepLinkTarget | undefined {
  if (location.page === 'review') return { kind: 'review', reviewId: location.reviewId };
  const home = location.home;
  const item = home.item;
  if (item) {
    const ref = prRef(item.subject.members[0]?.url ?? '');
    if (!ref) return undefined;
    const tab = linkTab(home.tab);
    return { kind: 'pr', pr: ref, ...(item.subject.kind === 'stack' ? { scope: 'stack' as const } : {}), ...(tab !== 'summary' ? { tab } : {}) };
  }
  if (home.muted) return { kind: 'queue', section: 'muted' };
  if (home.viewId) return { kind: 'queue', view: home.viewId };
  if (home.savedView) return { kind: 'queue', section: 'saved' };
  const f = home.filters;
  const section: QueueSection | undefined =
    f.involvement === 'response' ? 'response'
      : f.starredOnly ? 'starred'
        : f.attention === 'requested' || f.attention === 'updated' ? f.attention
          : f.kind === 'stack' ? 'stacks'
            : undefined;
  const filters: LinkFilters = {};
  if (f.repo && f.repo !== 'all' && 'value' in linkFilters(new Map([['repo', f.repo]]))) filters.repo = f.repo;
  if (f.readStatus !== 'all') filters.read = f.readStatus;
  return { kind: 'queue', ...(section ? { section } : {}), ...(Object.keys(filters).length ? { filters } : {}) };
}

// ── Re-validating values that crossed IPC ──

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const optional = (value: unknown, valid: (text: string) => boolean): value is string | undefined =>
  value === undefined || (typeof value === 'string' && valid(value));
const matches = (pattern: RegExp) => (text: string) => pattern.test(text);

function validPrRef(value: unknown): PrRef | undefined {
  if (!record(value) || value.host !== 'github.com' || typeof value.owner !== 'string' || typeof value.repo !== 'string') return undefined;
  if (!OWNER.test(value.owner) || !validRepo(value.repo)) return undefined;
  if (typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || !NUMBER.test(String(value.number))) return undefined;
  return { host: 'github.com', owner: value.owner, repo: value.repo, number: value.number };
}
function validFile(value: unknown, review = false): FileLocator | undefined | false {
  if (value === undefined) return undefined;
  if (!record(value)) return false;
  const { path, anchor, line, endLine, side, sha } = value;
  if (!optional(path, validFilePath) || !optional(anchor, matches(ANCHOR)) || !optional(sha, matches(SHA40))) return false;
  if ((review && (anchor !== undefined || sha !== undefined)) || (path === undefined && anchor === undefined)) return false;
  const lineNumber = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 9_999_999);
  if (!lineNumber(line) || !lineNumber(endLine)) return false;
  if (endLine !== undefined && (line === undefined || (endLine as number) <= (line as number))) return false;
  if (side !== undefined && side !== 'before' && side !== 'after') return false;
  const file: FileLocator = {};
  if (path !== undefined) file.path = path;
  if (anchor !== undefined) file.anchor = anchor;
  if (line !== undefined) file.line = line as number;
  if (endLine !== undefined) file.endLine = endLine as number;
  if (side === 'before') file.side = 'before';
  if (sha !== undefined) file.sha = sha;
  return file;
}
function validFilters(value: unknown): LinkFilters | undefined | false {
  if (value === undefined) return undefined;
  if (!record(value)) return false;
  const parameters: Parameters = new Map();
  const names: [keyof LinkFilters, string][] = [['repo', 'repo'], ['author', 'author'], ['branch', 'branch'], ['status', 'status'], ['read', 'read'], ['kind', 'kind'], ['query', 'q']];
  for (const [key, name] of names) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !safe(field) || field.length > (VALUE_LIMITS[name] ?? VALUE_MAX)) return false;
    parameters.set(name, field);
  }
  const filters = linkFilters(parameters);
  return 'error' in filters ? false : (filters.value ?? {});
}
function validRepoTarget(value: Record<string, unknown>): { owner: string; repo: string } | undefined {
  return value.host === 'github.com' && typeof value.owner === 'string' && OWNER.test(value.owner) && typeof value.repo === 'string' && validRepo(value.repo)
    ? { owner: value.owner, repo: value.repo }
    : undefined;
}

/** Re-validates a target that crossed IPC. Unknown fields are dropped; an invalid target is `undefined`. */
export function parseDeepLinkTarget(value: unknown): DeepLinkTarget | undefined {
  if (!record(value)) return undefined;
  switch (value.kind) {
    case 'pr': {
      const pr = validPrRef(value.pr);
      if (!pr || (value.scope !== undefined && value.scope !== 'stack')) return undefined;
      if (value.tab !== undefined && !PR_TABS.includes(value.tab as PrTab)) return undefined;
      const file = validFile(value.file);
      if (file === false) return undefined;
      const target: PrLinkTarget = { kind: 'pr', pr, ...(value.scope ? { scope: 'stack' as const } : {}), ...(value.tab ? { tab: value.tab as PrTab } : {}) };
      if (file) target.file = file;
      for (const [key, , pattern] of LOCATOR_PARAMETERS) {
        const field = value[key];
        if (!optional(field, matches(pattern))) return undefined;
        if (field !== undefined) target[key] = field;
      }
      return target;
    }
    case 'conflicts': {
      const pr = validPrRef(value.pr);
      return pr ? { kind: 'conflicts', pr } : undefined;
    }
    case 'review': {
      if (typeof value.reviewId !== 'string' || !TRUSTED_REVIEW_ID.test(value.reviewId)) return undefined;
      const file = validFile(value.file, true);
      if (file === false || !optional(value.slide, matches(KEY)) || !optional(value.threadId, matches(KEY))) return undefined;
      return {
        kind: 'review',
        reviewId: value.reviewId,
        ...(value.slide !== undefined ? { slide: value.slide } : {}),
        ...(file ? { file } : {}),
        ...(value.threadId !== undefined ? { threadId: value.threadId } : {}),
      };
    }
    case 'queue': {
      if (value.section !== undefined && !QUEUE_SECTIONS.includes(value.section as QueueSection)) return undefined;
      if (!optional(value.view, matches(VIEW))) return undefined;
      const filters = validFilters(value.filters);
      if (filters === false) return undefined;
      return {
        kind: 'queue',
        ...(value.section ? { section: value.section as QueueSection } : {}),
        ...(value.view !== undefined ? { view: value.view } : {}),
        ...(filters ? { filters } : {}),
      };
    }
    case 'settings':
      if (value.section !== undefined && !SETTINGS_SECTIONS.includes(value.section as LinkSettingsSection)) return undefined;
      return { kind: 'settings', ...(value.section ? { section: value.section as LinkSettingsSection } : {}) };
    case 'activity':
      return { kind: 'activity' };
    case 'commit': {
      const repo = validRepoTarget(value);
      const file = validFile(value.file);
      if (!repo || typeof value.sha !== 'string' || !SHA.test(value.sha) || file === false || file?.path !== undefined) return undefined;
      return { kind: 'commit', host: 'github.com', ...repo, sha: value.sha, ...(file ? { file } : {}) };
    }
    case 'compare': {
      const repo = validRepoTarget(value);
      const file = validFile(value.file);
      if (!repo || typeof value.head !== 'string' || !validRefName(value.head) || file === false || file?.path !== undefined) return undefined;
      if (!optional(value.base, validRefName) || !optional(value.headOwner, matches(OWNER))) return undefined;
      return {
        kind: 'compare',
        host: 'github.com',
        ...repo,
        ...(value.base !== undefined ? { base: value.base } : {}),
        head: value.head,
        ...(value.headOwner !== undefined ? { headOwner: value.headOwner } : {}),
        ...(file ? { file } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Re-validates an error that crossed IPC. */
export function parseDeepLinkError(value: unknown): DeepLinkError | undefined {
  if (!record(value) || !DEEP_LINK_ERROR_CODES.includes(value.code as DeepLinkErrorCode)) return undefined;
  const route = (DEEP_LINK_ROUTES as readonly unknown[]).includes(value.route) ? (value.route as DeepLinkRoute) : undefined;
  const count = typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count > 0 ? value.count : undefined;
  return { code: value.code as DeepLinkErrorCode, ...(route ? { route } : {}), ...(count ? { count } : {}) };
}

/** The route word for a target, for log lines and analytics. Never contains input. */
export function targetRoute(target: DeepLinkTarget): DeepLinkRoute | 'commit' | 'compare' {
  if (target.kind === 'pr') return target.scope === 'stack' ? 'stack' : 'pr';
  return target.kind;
}
