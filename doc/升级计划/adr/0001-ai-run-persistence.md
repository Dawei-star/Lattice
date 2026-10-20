# ADR-0001: Persist AI Runs with Jobs and Append-Only Events

## Status
Accepted

## Context
AI tasks must continue after the assistant panel is closed and must be
recoverable after transient failures. The existing SQLite `jobs` queue already
provides idempotent enqueueing, cancellation, retry limits, and startup
recovery. Streaming deltas are ordered and can be much larger and more
frequent than a single job result, so storing them in `jobs.result` would make
resume and incremental reads awkward.

Provider API keys must not be written to the workspace database. A recovered
task may therefore lack the in-memory secret required to call the provider.

## Decision
Reuse `jobs` for the AI Run main record with `type = 'ai-run'` and `key =
runId`. Store ordered stream events in the separate `ai_run_events` table with
the unique key `(run_id, sequence)`. Expose enqueue, get, event pagination,
cancel, and resume Tauri commands, and run queued AI jobs in a dedicated
worker.

Persisted request payloads redact `apiKey`/`api_key`. The current process keeps
the original request in an in-memory pending map for background execution. If a
recovered job has no in-memory provider secret, it fails safely and asks the
user to resubmit instead of attempting an unauthenticated or guessed request.

## Consequences

### Positive
- Closing the AI panel no longer stops an enqueued Run in the current app process.
- Events can be replayed after a UI reconnect using `afterSequence`.
- Existing queue retry, cancellation, idempotency, and startup recovery are reused.
- Provider credentials never enter SQLite job payloads or event logs.

### Negative
- Cross-process restart recovery requires the user to resubmit unless a
  future secure provider-secret service restores the credential.
- The current worker is single-threaded and poll-based, so throughput and
  wake-up latency are intentionally modest.
- Durable Run commands are available, but the panel still uses the foreground
  stream by default; UI background-mode selection remains a follow-up.

## Alternatives Considered

**Store the full request in `jobs.payload`**
- Rejected because it would persist API keys and other provider credentials.

**Create a separate `ai_runs` table for all job state**
- Deferred because it would duplicate the stable queue lifecycle already used
  by workspace background tasks.

**Persist only the final result**
- Rejected because reconnecting clients need ordered progress and delta events.

