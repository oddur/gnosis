/**
 * Imported first in `src/main.ts`, so the lock is requested and `open-url` is buffered before any other module runs
 * and before anything could change `userData`. See `single-instance.ts`.
 */
import { app } from 'electron';
import { startSingleInstance } from './single-instance';

export const instance = startSingleInstance(app, { env: process.env, argv: process.argv, execPath: process.execPath });
