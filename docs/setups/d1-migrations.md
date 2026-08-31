# D1 migrations setup

Use this when you want to persist triage results to Cloudflare D1.

## One-time setup

Create the database:

```bash
wrangler d1 create triage-results
```

Bind it in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "TRIAGE_RESULTS"
database_name = "triage-results"
database_id = "<your-db-id>"
```

## Apply migrations

Run the npm script:

```bash
npm run migrate
```

That command applies all pending files under `migrations/` in order.

## Adding future migrations

1. Add a new numbered SQL file under `migrations/`
2. Commit it
3. Re-run `npm run migrate`

The existing schema creates a `triage_results` table with one row per actionable event.
