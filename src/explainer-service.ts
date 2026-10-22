import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { getProvider } from '../lib/provider';
import { normalizeModelSelection } from '../lib/models';
import { buildExplainerPrompt, EXPLAINER_SYSTEM, parseExplainer } from '../lib/explainer';
import type { GenerateExplainerRequest, InteractiveExplainer, Preferences, ReviewGuide, Slide } from '../lib/types';

interface Dependencies {
  reviewsDir: () => string;
  preferences: () => Preferences;
  validate: (artifact: InteractiveExplainer, signal: AbortSignal) => Promise<void>;
  provider?: typeof getProvider;
}

function fingerprint(review: ReviewGuide, slide: Slide): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        review.prUrl,
        review.headSha,
        slide.title,
        slide.narrative,
        slide.diffHunks,
        slide.explainerContext,
      ])
    )
    .digest('hex');
}

export function createExplainerService(deps: Dependencies) {
  const running = new Map<
    string,
    { owner: number; controller: AbortController; promise: Promise<InteractiveExplainer> }
  >();
  function keyFor(req: GenerateExplainerRequest) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(req.reviewId) || typeof req.slideId !== 'string' || req.slideId.length > 200)
      throw new Error('Invalid review or slide ID.');
    if (req.refinement !== undefined && (typeof req.refinement !== 'string' || req.refinement.length > 2000))
      throw new Error('Keep refinements under 2,000 characters.');
    return `${req.reviewId}:${req.slideId}`;
  }
  const load = (file: string): ReviewGuide => JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewGuide;
  async function run(req: GenerateExplainerRequest, signal: AbortSignal): Promise<InteractiveExplainer> {
    const file = path.join(deps.reviewsDir(), `${req.reviewId}.json`);
    const review = load(file);
    const slide = review.slides.find((s) => s.id === req.slideId);
    if (!slide) throw new Error('This review no longer contains the requested slide.');
    if (slide.explainer && !req.refinement?.trim()) {
      try {
        return parseExplainer(JSON.stringify(slide.explainer), slide);
      } catch {
        delete slide.explainer;
      }
    }
    if (!slide.diffHunks.length) throw new Error('This slide has no source code to explain.');
    const revision = fingerprint(review, slide);
    const prefs = deps.preferences();
    const selection = normalizeModelSelection(prefs.provider, prefs.model);
    const provider = (deps.provider ?? getProvider)(selection.provider);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-explainer-'));
    try {
      const prompt = buildExplainerPrompt(review, slide, req.refinement);
      let repair = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await provider.generate({
          content: prompt + repair,
          systemPrompt: EXPLAINER_SYSTEM,
          model: selection.model,
          thinking: true,
          isolated: true,
          cwd,
          signal,
        });
        signal.throwIfAborted();
        let artifact: InteractiveExplainer;
        try {
          artifact = parseExplainer(raw, slide);
          await deps.validate(artifact, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (attempt === 1) throw error;
          repair =
            '\nThe previous artifact failed validation. Correct it and return the full JSON again.\nError: ' +
            String(error).slice(0, 1000) +
            '\nPrevious artifact:\n' +
            raw.slice(0, 140000);
          continue;
        }
        signal.throwIfAborted();
        const latest = load(file);
        const target = latest.slides.find((s) => s.id === req.slideId);
        if (!target || fingerprint(latest, target) !== revision)
          throw new Error('The review changed while the explainer was generating. Reopen the review and try again.');
        target.explainer = artifact;
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify(latest));
          fs.renameSync(temp, file);
        } finally {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
        return artifact;
      }
      throw new Error('Could not generate an explainer.');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
  return {
    generate(req: GenerateExplainerRequest, owner: number): Promise<InteractiveExplainer> {
      const key = keyFor(req);
      const active = running.get(key);
      if (active && !active.controller.signal.aborted) {
        if (active.owner !== owner) throw new Error('This explainer is already generating in another window.');
        return active.promise;
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error('Explainer generation timed out. Try a simpler example.')),
        180000
      );
      const promise = run(req, controller.signal).finally(() => {
        clearTimeout(timeout);
        if (running.get(key)?.controller === controller) running.delete(key);
      });
      running.set(key, { controller, owner, promise });
      return promise;
    },
    cancel(req: GenerateExplainerRequest, owner: number) {
      const active = running.get(keyFor(req));
      if (active?.owner === owner) active.controller.abort(new Error('Explainer generation cancelled.'));
    },
    cancelOwner(owner: number) {
      for (const active of running.values())
        if (active.owner === owner) active.controller.abort(new Error('Explainer generation cancelled.'));
    },
  };
}
