/** Vite's worker imports: the default export constructs the bundled worker. */
declare module '*?worker&inline' {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}
