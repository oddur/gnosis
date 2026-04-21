import AdmZip from 'adm-zip';
import type { ReviewGuide, ReviewHistoryEntry } from './types';

// .gr (Gnosis Review) file format — a zip containing everything
// needed to reconstitute a review on another machine:
//   - review.json    the full ReviewGuide
//   - metadata.json  { schemaVersion, history, exportedAt, appVersion, sourceReviewId }
//   - prompt.md      (optional) the system prompt used to generate it
//
// Bump SCHEMA_VERSION when the shape of the archive changes in a way
// that older importers can't handle. Minor additive changes (new
// optional fields) don't need a bump.
export const ARCHIVE_SCHEMA_VERSION = 1;

export interface ArchiveMetadata {
  schemaVersion: number;
  /** The full ReviewHistoryEntry (sans id) so the importer can recreate the index entry. */
  history: Omit<ReviewHistoryEntry, 'id'>;
  exportedAt: string;
  appVersion?: string;
  sourceReviewId: string;
}

export interface BuildArchiveInput {
  review: ReviewGuide;
  history: ReviewHistoryEntry;
  prompt?: string;
  appVersion?: string;
}

export function buildArchive(input: BuildArchiveInput): Buffer {
  const { review, history, prompt, appVersion } = input;
  const zip = new AdmZip();

  const { id: sourceReviewId, ...historyMinusId } = history;
  const metadata: ArchiveMetadata = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    history: historyMinusId,
    exportedAt: new Date().toISOString(),
    appVersion,
    sourceReviewId,
  };

  zip.addFile('metadata.json', Buffer.from(JSON.stringify(metadata, null, 2)));
  zip.addFile('review.json', Buffer.from(JSON.stringify(review, null, 2)));
  if (prompt) zip.addFile('prompt.md', Buffer.from(prompt));

  return zip.toBuffer();
}

export interface ParsedArchive {
  metadata: ArchiveMetadata;
  review: ReviewGuide;
  prompt: string | null;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export function parseArchive(buffer: Buffer): ParsedArchive {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new ArchiveError(`Not a valid .gr archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const metadataEntry = zip.getEntry('metadata.json');
  const reviewEntry = zip.getEntry('review.json');
  if (!metadataEntry || !reviewEntry) {
    throw new ArchiveError('Archive is missing metadata.json or review.json.');
  }

  let metadata: ArchiveMetadata;
  try {
    metadata = JSON.parse(metadataEntry.getData().toString('utf-8')) as ArchiveMetadata;
  } catch (err) {
    throw new ArchiveError(`metadata.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (metadata.schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    throw new ArchiveError(
      `Archive schema is newer than this app understands (v${metadata.schemaVersion} > v${ARCHIVE_SCHEMA_VERSION}). Upgrade Gnosis.`
    );
  }

  let review: ReviewGuide;
  try {
    review = JSON.parse(reviewEntry.getData().toString('utf-8')) as ReviewGuide;
  } catch (err) {
    throw new ArchiveError(`review.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof review.prTitle !== 'string' || !Array.isArray(review.slides)) {
    throw new ArchiveError('review.json is missing required fields (prTitle, slides).');
  }

  const promptEntry = zip.getEntry('prompt.md');
  const prompt = promptEntry ? promptEntry.getData().toString('utf-8') : null;

  return { metadata, review, prompt };
}
