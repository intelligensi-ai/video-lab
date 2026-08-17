# Operations runbook

- Runtime unavailable: check `/v1/runtime/status`, adapter env, and runtime health path.
- Queue stuck: inspect server-only `generationQueue/{generationId}`, `generationActive/{uid}` and `runtimeState/queueMetrics`; never expose these records to the browser. Verify the runtime job before reclaiming an expired lease.
- Worker lease stuck: allow expiry, then reclaim transactionally.
- Generation failed: inspect trace ID and safe error; infrastructure failures release credits.
- Output upload failed: retry upload/finalization or refund.
- Credits reserved incorrectly: append refund/release ledger entry; never edit ledger history.
- Pause submissions: `POST /v1/admin/runtime/pause`.
- Resume submissions: `POST /v1/admin/runtime/resume`.
- Enable kill switch: `POST /v1/admin/runtime/stop`.
- Refund generation: admin credit adjustment with audit reason.
- Suspend abusive account: update server-controlled user status and audit.
- Restore service: clear kill switch by resume after runtime health passes.
- Worker invocation: production submissions enqueue the private Firebase task
  function `processVideoLabJobs`. It transactionally claims either a durable
  Director job or generation job, uses a bounded lease, and retries transient
  failures without duplicating inference. `/v1/internal/process-next` remains a
  token-protected recovery probe, not the normal browser-triggered worker.
- Director queue stuck: inspect server-only `storyboardAsyncJobs`,
  `storyboardAsyncActive` and `runtimeState/storyboardAsyncQueueMetrics`. Reclaim
  only an expired lease. Do not create a replacement job for a browser timeout;
  the browser should reconnect to the original opaque job ID.
- Rate-limit store unavailable: generation-facing endpoints fail closed with
  `rate_limit_unavailable`. Restore Firestore before retrying; do not bypass the
  distributed counter in production.
- Entitlement denied: verify the server-owned `videoLabEntitlements/{uid}`
  status, operation list, expiry and policy version. The staging UID allow-list
  is for bounded acceptance only and must be removed after testing.
- Runtime rotation: publish a fresh Deploy Studio lease, wait for Video Lab readiness, then retire the old endpoint. Production environment fallback should remain disabled.
