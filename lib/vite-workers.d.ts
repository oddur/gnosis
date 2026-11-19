/** Vite's worker imports: the default export constructs the bundled worker. */
declare module '*?worker&inline' {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}
/** Vite's `?raw` imports: the file's text. */
declare module '*?raw' {
  const text: string;
  export default text;
}
/** Vite's `?url` imports: the URL of the emitted asset. */
declare module '*?url' {
  const url: string;
  export default url;
}
