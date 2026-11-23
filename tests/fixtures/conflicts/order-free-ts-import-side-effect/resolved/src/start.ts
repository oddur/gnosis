import { register } from './register';
import './polyfill-fetch';
import { client } from './client';

export function start(): void {
  register();
}
