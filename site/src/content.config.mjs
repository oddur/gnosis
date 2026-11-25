// The user docs at /docs. One MDX file per page; `order` sets the sidebar position.
// A .mjs file, so the repository's root `tsc` (which includes every .ts file) does not try to resolve astro:content.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({ pattern: '*.mdx', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number().int().positive(),
    /** The whole page describes something only in a pre-release build. */
    prerelease: z.boolean().optional(),
  }),
});

export const collections = { docs };
