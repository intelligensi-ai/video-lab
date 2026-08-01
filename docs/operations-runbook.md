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
- Worker invocation: call `/v1/internal/process-next` only from the trusted scheduler with `VIDEO_LAB_WORKER_TOKEN`; rotate the token if it appears in logs or configuration output.
- Runtime rotation: publish a fresh Deploy Studio lease, wait for Video Lab readiness, then retire the old endpoint. Production environment fallback should remain disabled.
