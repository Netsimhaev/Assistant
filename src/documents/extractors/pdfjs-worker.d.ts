/**
 * `pdfjs-dist` ships types for `pdf.mjs` but none for its worker module.
 * `pdf.ts` imports the worker only to hand it to pdf.js as the in-process
 * worker (`globalThis.pdfjsWorker`); the one property pdf.js reads from it
 * is `WorkerMessageHandler`, and nothing here calls it.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
