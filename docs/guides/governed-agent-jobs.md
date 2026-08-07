# Governed OAuth Agent Jobs

This is the operator runbook for governed agent jobs. It covers the
PostgreSQL-only `submit_agent` path, not local `gbrain agent run` and not the
general Minions deployment described in [minions-deployment.md](minions-deployment.md).

Verified on 2026-08-07:

- fork: `https://github.com/element-bendr/gbrain`
- merged commit: `bae5c064eac45e3ce1cc9ba04dd83ba2650c7b66`
- fork branch: `master`
- prior installed version: `0.42.53.0` from `garrytan/gbrain#814258d`
- live gate: PostgreSQL + OAuth HTTP MCP + `ollama:gemma4:e2b`

PR #1 is merged into the fork's `master`. Installation and rollback below
operate on the global Bun package only; they do not configure an agent client.

## Architecture and authority

```text
OAuth client registration
  ├─ scopes: read + agent
  ├─ inherited tool allowlist
  ├─ source and slug fence
  ├─ provider/model allowlist
  ├─ max concurrent jobs
  └─ daily budget
          │
          ▼
submit_agent ──atomic admission──> PostgreSQL minion_jobs
          │                              │
          │                              ▼
          │                       governed worker
          │                              │
          │                       gateway tool loop
          │                              │
          ▼                              ▼
owner-scoped controls <──── job state, events, spend, audit
```

The authenticated OAuth client ID is the owner. Request fields such as
`owner_client_id`, `correlation_id`, and `causation_id` are never authority.
Admission is atomic: concurrency, idempotency, and daily budget are checked in
the same PostgreSQL transaction that creates the job.

## Install the fork build

Record the current version and rollback source before changing the global
package:

```bash
gbrain --version
rg -n '"gbrain".*github:' ~/.bun/install/global/bun.lock
```

For the verified host, the rollback source is
`github:garrytan/gbrain#814258d` (`gbrain 0.42.53.0`). Install the governed
fork master:

```bash
GBRAIN_BRANCH_SPEC='github:element-bendr/gbrain#master'

bun remove --global gbrain
bun add --global "$GBRAIN_BRANCH_SPEC"
gbrain --version
```

Expected version: `gbrain 0.42.73.3`. Confirm that the installed Git resolution
matches the current fork master before starting services:

```bash
git ls-remote https://github.com/element-bendr/gbrain.git \
  refs/heads/master
rg -n '"gbrain".*element-bendr/gbrain' ~/.bun/install/global/bun.lock
```

Do not run the governed worker against PGLite. The durable admission, lease,
ownership, and spend invariants require PostgreSQL.

## Configure provider and pricing policy

Every submission must name one explicit `provider:model`. No fallback model is
used for governed jobs. Authority narrows in one direction:

```text
GBrain operator policy
        ↓
OAuth client allowed_providers / allowed_models
        ↓
per-job requested model
```

Each level may narrow the level above it; none may widen it. Static recipe
models are eligible by default. A model absent from the static catalog is
eligible only when the operator has configured it through `chat_model`, the
effective `chat_fallback_chain`, or the dedicated durable allowlist:

```bash
gbrain config set agent.approved_models \
  'openai:gbrain-test-future-model,anthropic:another-reviewed-model'
```

Use `agent.approved_models` when approving several governed models. Do not add
models to `chat_fallback_chain` merely to authorize them: that setting also
changes ordinary chat fallback behavior. Values are validated as bounded,
known-provider, tool-capable `provider:model` identifiers and stored in a
canonical sorted form.

The model must satisfy all of these gates:

1. the provider recipe supports chat, tools, and subagents;
2. the operator explicitly configured the model or it is in the static catalog;
3. the provider is enabled globally;
4. the OAuth client allows the exact provider and normalized model;
5. required provider credentials and canonical pricing exist before execution.

Registration establishes eligibility and may happen before credentials or
pricing are installed. `submit_agent` independently checks current provider
enablement, credentials, and pricing before queueing paid work. The worker
rechecks pricing before each provider call. Registration never proves remote
availability; provider rejection remains a runtime result.

Unknown or unapproved pricing fails before queueing. The only approved zero-cost
exception is an explicitly configured local Ollama model. The verified local
configuration is:

```bash
ollama show gemma4:e2b >/dev/null
gbrain config set chat_model ollama:gemma4:e2b
gbrain config set agent.enabled_providers ollama
gbrain config get chat_model
gbrain config get agent.enabled_providers
```

Remote providers retain their normal credential requirements and must have
non-zero canonical pricing. Never use a zero price to bypass an unknown remote
rate.

Removing a dynamic model from `agent.approved_models` blocks new registrations
and new submissions immediately. Already queued paid jobs retain their exact
audited admission model; they do not silently fall back. Existing execution
readiness checks still apply, and the local zero-cost exception rechecks current
operator configuration before execution.

## Start HTTP MCP and the worker

Keep Dynamic Client Registration disabled for machine clients. Register them
with the trusted CLI instead.

```bash
gbrain serve --http --port 19140 --bind 127.0.0.1 \
  --suppress-bootstrap-token
```

For a foreground smoke worker:

```bash
gbrain jobs work --queue default
```

For a persistent Linux user service:

```bash
gbrain jobs service install
systemctl --user restart gbrain-worker.service
systemctl --user status gbrain-worker.service
gbrain jobs supervisor status --json
```

The service installer writes no secrets into the unit. Add provider credentials
only to the mode-`0600` environment file printed by the installer. See
[minions-deployment.md](minions-deployment.md#deployment-systemd) for platform
supervision and crash-recovery details.

## Register a least-privilege client

This example may read and delegate only `get_page` under `projects/`, use one
explicit Ollama model, run one job at a time, and spend at most USD 0.05/day.
The control capabilities are separate from tools inherited by the child.

```bash
umask 077
GBRAIN_CREDENTIAL_FILE=$(mktemp)

gbrain auth register-client governed-agent \
  --grant-types client_credentials \
  --scopes 'read agent' \
  --token-endpoint-auth-method client_secret_post \
  --bound-tools get_page \
  --control-capabilities submit_agent,get_owned_job,list_owned_jobs,cancel_owned_job,message_owned_job,get_owned_job_events,whoami \
  --allowed-providers ollama \
  --allowed-models ollama:gemma4:e2b \
  --bound-source default \
  --bound-slug-prefixes projects/ \
  --bound-max-concurrent 1 \
  --budget-usd-per-day 0.05 \
  >"$GBRAIN_CREDENTIAL_FILE"

chmod 600 "$GBRAIN_CREDENTIAL_FILE"
```

The secret is revealed once. Move the file into the operator's secret store;
never commit it or copy it into an agent prompt.

## Admission and owned operations

`submit_agent` requires an explicit model and may only narrow its registration
bindings. Useful request fields are:

| Field | Rule |
|---|---|
| `model` | required exact `provider:model`; no fallback |
| `allowed_tools` | subset of registered `bound_tools` |
| `allowed_slug_prefixes` | subset of the registered slug fence |
| `max_turns` | default 20, hard maximum 100 |
| `per_job_budget_usd` | optional, non-negative, no greater than daily cap |
| `idempotency_key` | owner-scoped; same key and payload replays the job ID |
| `correlation_id`, `causation_id` | bounded trace metadata, never authority |

Owner-scoped controls re-authorize ownership on every call:

| Operation | Result |
|---|---|
| `get_owned_job` | one owned job |
| `list_owned_jobs` | bounded owned jobs only |
| `cancel_owned_job` | idempotent cancel; releases inflight capacity |
| `message_owned_job` | message to a non-terminal owned job |
| `get_owned_job_events` | bounded ascending events after a numeric cursor |

PostgreSQL BIGINT event IDs are returned only when they fit JavaScript's safe
integer range. Larger values fail closed instead of returning a rounded cursor.

## Budgets and accounting

- Registration sets the durable daily client cap.
- A request may set a smaller per-job cap; it cannot widen the daily cap.
- Admission reserves budget atomically with the job.
- The worker settles actual gateway usage and releases unused reservation.
- Retries reuse the owner-scoped idempotency record rather than double-reserving.
- Missing pricing, disabled providers, missing credentials, exhausted budget,
  and concurrency saturation all refuse before provider execution.

Inspect the authenticated binding with `whoami`, owned jobs with
`list_owned_jobs`, and operator spend through the admin dashboard. Agent audit
records never contain prompt text; they record prompt byte count, owner, model,
bindings, budget state, and outcome.

## Credential rotation

OAuth client secrets are hashed and cannot be recovered or rotated in place.
Create the replacement first, update the consuming secret store, prove the new
client, then revoke the old client:

```bash
gbrain auth register-client governed-agent-rotated \
  --grant-types client_credentials \
  --scopes 'read agent' \
  --token-endpoint-auth-method client_secret_post \
  --bound-tools get_page \
  --control-capabilities submit_agent,get_owned_job,list_owned_jobs,cancel_owned_job,message_owned_job,get_owned_job_events,whoami \
  --allowed-providers ollama \
  --allowed-models ollama:gemma4:e2b \
  --bound-source default \
  --bound-slug-prefixes projects/ \
  --bound-max-concurrent 1 \
  --budget-usd-per-day 0.05
# Prove the replacement with the smoke gate below, then revoke the old client.
gbrain auth revoke-client gbrain_cl_OLD_CLIENT_ID
```

Revocation deletes the client and cascades to its access tokens and auth codes.
It does not reassign old jobs; those remain owned by the revoked client ID and
are unavailable to the replacement. Drain or cancel owned work before rotation
when later control is required.

## Required smoke gate

Run the focused PostgreSQL contract first against a disposable test database:

```bash
DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/gbrain_governed_test' \
  bun test test/e2e/governed-owned-jobs.test.ts \
    test/e2e/governed-admission.test.ts \
    test/e2e/governed-gateway-budget.test.ts

bun run typecheck
bun run verify
```

Then register two clients with identical least-privilege bindings and prove the
live HTTP path:

1. missing and invalid bearer tokens return HTTP 401;
2. `whoami` returns each exact OAuth client ID and binding;
3. a disallowed model and negative per-job budget are refused;
4. two simultaneous submissions at concurrency 1 admit exactly one;
5. identical idempotent replay returns the same job ID and changed payload is refused;
6. the owner can cancel twice, and cancellation releases capacity;
7. the second client cannot read, list, cancel, message, or retrieve events;
8. a real job completes through the worker with the requested model persisted;
9. event pagination is JSON-safe and the second page starts after `next_cursor`;
10. terminal jobs reject messages.

The 2026-08-07 live gate passed on `127.0.0.1:19140`: job `13` completed via
`ollama:gemma4:e2b`; event pages were `1` then `0`, with `next_cursor=18`.

## Failure recovery

| Symptom | Action |
|---|---|
| Jobs remain `waiting` | Check `gbrain jobs supervisor status --json`; restart the user service or foreground worker. |
| Worker repeatedly exits | Inspect `journalctl --user -u gbrain-worker.service -n 100 --no-pager` and the supervisor audit log. |
| `provider_disabled` / `model_not_allowed` | Compare global provider config, explicit chat model, and the OAuth allowlists. |
| `pricing_unavailable` | Add verified canonical pricing, or explicitly configure the approved local Ollama model. Never invent a remote rate. |
| `budget_exhausted` | Inspect settled/reserved spend; wait for the UTC budget window or register a reviewed cap. |
| `concurrency_limit` | Wait, cancel an owned waiting job, or review the registered cap. |
| Owner cannot control a job | Use the original OAuth client. Ownership is immutable and cannot be forged or transferred. |
| Event JSON serialization fails | Require a build containing `24ef76a2` or later. |

Worker crashes do not erase jobs. PostgreSQL retains leases, reservations, inbox
messages, events, and audit rows; the supervisor restarts the worker and the
stalled-job sweep reclaims expired leases.

## Roll back the installed branch

Stop the new entry points before replacing the binary:

```bash
systemctl --user stop gbrain-worker.service 2>/dev/null || true
gbrain jobs supervisor stop 2>/dev/null || true
```

Reinstall the exact prior package recorded before installation:

```bash
GBRAIN_ROLLBACK_SPEC='github:garrytan/gbrain#814258d'

bun remove --global gbrain
bun add --global "$GBRAIN_ROLLBACK_SPEC"
gbrain --version
```

Expected verified rollback version: `gbrain 0.42.53.0`. Bun must remove the
current global package first; switching directly between Git origins can fail
with `DependencyLoop`.

Do not down-migrate PostgreSQL. Migrations 126-129 are additive. The verified
rollback binary connected successfully with schema version 129; its
`schema_version` doctor check returned `ok` even though its own latest known
migration was 119. Re-enable the previous worker/server only after its normal
health check passes.

The built-in user-service rollback is separate and idempotent:

```bash
gbrain jobs service uninstall
```

It removes the unit but deliberately preserves the mode-`0600` worker environment
file. Delete that file only as an explicit credential-destruction action.
