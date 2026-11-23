// All compute, off the main thread. A thin wrapper: the pipeline itself is
// src/pipeline.js, which the harness also calls directly.
//
// Messages in:  {type:'run', jobId, rgba, settings}
// Messages out: 'progress', 'done' (with the plan), 'error' -- all carry jobId,
// and the app drops any whose jobId is stale.

import { runPipeline } from './pipeline.js';

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    const onProgress = (stage) => self.postMessage({ type: 'progress', jobId: msg.jobId, stage });
    const t0 = performance.now();
    const plan = runPipeline(msg.rgba, msg.settings, { onProgress });
    self.postMessage({ type: 'done', jobId: msg.jobId, plan, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({
      type: 'error', jobId: msg.jobId,
      message: String((err && err.message) || err), stack: err && err.stack, code: err && err.code,
    });
  }
};
