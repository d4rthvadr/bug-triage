# Checkout API Test Service Handoff

## Purpose

Create a small companion `checkout-api` repository for end-to-end testing of the bug-triage Worker.

The service must be runnable locally, persist a minimal checkout record in SQLite, emit realistic Sentry errors, and expose source files that the triage agent can inspect through GitHub. It is a test fixture and proof of concept, not a production checkout system.

The companion repository owner is supplied during setup. Do not hardcode `acme` as the owner.

## Approved Scope

- Bun-first TypeScript runtime
- Node-compatible APIs where practical
- SQLite persistence
- Official Sentry Node/Bun-compatible SDK
- Error and log collection only
- Two HTTP endpoints:
  - `GET /health`
  - `POST /checkout`
- Local execution through Bun or compatible Node tooling
- GitHub-hosted source for real triage investigation

## Explicit Exclusions

Do not add the following in this phase:

- Frontend or browser client
- Authentication or authorization
- Real payment-provider integration
- Queues or background workers
- Production deployment infrastructure
- Metrics, tracing, profiling, OpenTelemetry, or general telemetry
- Sentry webhook receiving logic in `checkout-api`
- Multi-service or multi-repository orchestration
- Production-grade checkout business rules
- A migration framework for SQLite

## Runtime Contract

### `GET /health`

Returns HTTP `200` when the HTTP server and SQLite connection are available.

The response should include a small JSON object such as:

```json
{
  "status": "ok",
  "database": "ready"
}
```

If SQLite is unavailable, return a non-2xx response with an actionable error body.

### `POST /checkout`

Accept a JSON request representing a minimal checkout:

```json
{
  "customerId": "customer-123",
  "productId": "sku-123",
  "quantity": 1,
  "failureMode": "none"
}
```

Supported `failureMode` values:

- `none`: validate the request, insert an order in SQLite, and return a success response.
- `validation`: return a controlled `400` validation response without inserting an order.
- `undefined-user`: intentionally execute the known undefined-property failure path and return a controlled `500` response.

The deliberate failure must produce an error matching the triage agent's remediation pattern, for example:

```text
Cannot read properties of undefined (reading 'userId')
```

A normal success response should contain a stable order identifier and enough request context to verify persistence:

```json
{
  "orderId": "order-...",
  "status": "created"
}
```

The server must not expose stack traces or sensitive environment values in HTTP responses.

## Source Layout

The implementation should use a structure similar to:

```text
checkout-api/
  src/
    server.ts
    controllers/
      checkout.ts
    services/
      checkout/
        orderService.ts
    db/
      database.ts
      orders.ts
    observability/
      sentry.ts
  .github/
    CODEOWNERS
  .env.example
  README.md
  package.json
  tsconfig.json
```

The intentional failure must live in or be called from:

```text
src/services/checkout/orderService.ts
```

The request-to-service path should include:

```text
src/controllers/checkout.ts
```

This gives the triage agent meaningful stack frames and GitHub-searchable source paths.

## SQLite Model

Use one minimal table:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

The service should:

- Initialize the database on startup or first request.
- Use parameterized queries.
- Insert an order only after request validation succeeds.
- Provide a small repository function for creating and retrieving orders as needed by tests.
- Default to a local file such as `./data/checkout.sqlite`.

## Sentry Integration

Initialize the Sentry SDK only when `SENTRY_DSN` is configured. The service must still run locally without Sentry for basic development and tests.

Environment variables:

```text
SENTRY_DSN=
SENTRY_ENVIRONMENT=local
SENTRY_RELEASE=
DATABASE_PATH=./data/checkout.sqlite
PORT=3000
```

Capture the deliberate checkout failure with useful context:

- `project`: configured in Sentry as `checkout-api`
- `endpoint`: `/checkout`
- `failureMode`: `undefined-user`
- `customerId` only if it is safe test data
- Product and order context where useful

Use Sentry error capture and structured logs only. Do not enable performance tracing, profiling, metrics, or OpenTelemetry.

The error path should flush pending Sentry events before the process ends when running a short-lived test command. For the long-running HTTP server, use the SDK's normal request lifecycle behavior and avoid blocking successful responses on telemetry.

## Sentry Project Configuration

Create or use a Sentry project named:

```text
checkout-api
```

Configure the Sentry issue webhook to send `triggered` events to the triage Worker endpoint:

```text
POST /webhook/sentry
```

The resulting event should contain:

- Project: `checkout-api`
- Level: `error`
- Title containing the undefined-property error
- Culprit or stack frame pointing to `src/services/checkout/orderService.ts`
- Additional frame context through `src/controllers/checkout.ts`

The Sentry webhook secret belongs to the triage Worker. It must not be copied into the checkout-api repository.

## GitHub Investigation Contract

The companion repository must include a root CODEOWNERS file:

```text
src/services/checkout/* @checkout-team
```

The triage Worker should map the Sentry project to the real repository with:

```json
{
  "checkout-api": {
    "owner": "<github-owner>",
    "repo": "checkout-api",
    "branch": "main"
  }
}
```

A real triggered event should allow the triage Worker to:

1. Search GitHub for the culprit and error terms.
2. Find `src/services/checkout/orderService.ts`.
3. Fetch recent commits for the affected file.
4. Read CODEOWNERS.
5. Suggest `@checkout-team` as the owner.
6. Produce a P1 report because `checkout-api` is a critical project for the current severity rules.

## Local End-to-End Workflow

### Start the companion service

From the `checkout-api` repository:

```bash
bun install
cp .env.example .env
bun run dev
```

Verify readiness:

```bash
curl http://localhost:3000/health
```

### Trigger a successful checkout

```bash
curl -X POST http://localhost:3000/checkout \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "customer-123",
    "productId": "sku-123",
    "quantity": 1,
    "failureMode": "none"
  }'
```

Confirm that the response is successful and an order exists in SQLite.

### Trigger the Sentry error

```bash
curl -X POST http://localhost:3000/checkout \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "customer-123",
    "productId": "sku-123",
    "quantity": 1,
    "failureMode": "undefined-user"
  }'
```

Confirm that:

- The service returns a controlled `500` response.
- Sentry receives the event.
- The event is grouped as an error in the `checkout-api` project.
- The source location points into `src/services/checkout/orderService.ts`.

### Run the triage Worker

Configure the triage Worker with the real repository:

```bash
PROJECT_REPOSITORY_MAP='{"checkout-api":{"owner":"<github-owner>","repo":"checkout-api","branch":"main"}}'
```

Also configure the required Worker secrets and bindings according to the triage-agent setup documentation. Start the Worker and verify that the Sentry webhook is delivered.

Expected result:

- The Worker acknowledges the webhook quickly with `200 OK`.
- The asynchronous agent identifies the alert as P1.
- GitHub investigation finds the checkout service file.
- CODEOWNERS produces `@checkout-team` as the suggested owner.
- The triage report is logged and routed according to configured integrations.

## Verification Requirements

The companion repository is ready for integration testing when all of these pass:

1. `bun install` completes.
2. `bun test` passes.
3. `GET /health` returns `200` with SQLite ready.
4. A normal checkout creates an order in SQLite.
5. Invalid input returns `400` and does not create an order.
6. `failureMode: "undefined-user"` produces the intended `TypeError`.
7. Sentry captures the error when `SENTRY_DSN` is configured.
8. The stack frame references `src/services/checkout/orderService.ts`.
9. The triage Worker receives the Sentry webhook.
10. GitHub investigation finds the affected file and CODEOWNERS entry.
11. The triage Worker emits the expected P1 report.

## Implementation Notes

- Prefer the official Sentry Node SDK unless Bun compatibility requires a different official package or adapter.
- Keep the deliberate failure deterministic and isolated behind `failureMode`; do not make normal checkout requests flaky.
- Use test-only customer and product values in examples.
- Do not commit `.env` files, Sentry DSNs, GitHub tokens, or webhook secrets.
- Keep the repository public or accessible to the GitHub token used by the triage Worker.
- Add a README section showing how to run the local service and reproduce both successful and failing requests.

## Deferred Work

- Real payment authorization
- Authentication and customer identity
- Inventory management
- Idempotency and retry semantics
- Production database hosting
- Deployment automation
- Sentry resolved-event lifecycle tests
- Triage Worker D1 persistence fixes
- Multi-source alert ingestion
