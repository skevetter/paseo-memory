// Calibration fixture for per-tier duplicate thresholds and search floors.
// Each memory is "title\ncontent", the same text the store embeds.

export const CALIBRATION = {
  // Restatements of the same fact: must reach the tier's duplicate threshold.
  duplicates: [
    [
      "Picked Postgres for the warehouse\nWhy: joins and JSONB",
      "Picked Postgres for the warehouse\nWhy: joins and JSONB support",
    ],
    [
      "Run make lint before every commit\nThe CI lint job fails otherwise",
      "Run make lint before each commit\nOtherwise the CI lint job fails",
    ],
    [
      "Airflow DAG ids are snake_case\nWhat: dag ids use snake_case names",
      "Airflow DAG ids use snake_case\nWhat: DAG ids are snake_case names",
    ],
  ],
  // Same project and topic area, different facts: must stay below the duplicate threshold.
  distinct: [
    [
      "Picked Postgres for the warehouse\nWhy: joins and JSONB",
      "Picked Redis for the session cache\nWhy: TTLs and speed",
    ],
    [
      "Run make lint before every commit\nThe CI lint job fails otherwise",
      "Run make test before every push\nThe integration suite takes ten minutes",
    ],
    [
      "Airflow DAG ids are snake_case\nWhat: dag ids use snake_case names",
      "Airflow DAGs run in the UTC timezone\nWhat: schedules are written in UTC",
    ],
    [
      "Auth tokens refresh every 15 minutes\nWhere: services/auth/refresh.ts",
      "Auth tokens are stored in the OS keychain\nWhere: services/auth/store.ts",
    ],
  ],
  // Query, relevant memory, irrelevant memory (no keyword overlap with the relevant one).
  retrieval: [
    [
      "which database engine was selected",
      "Picked Postgres for the warehouse\nWhy: joins and JSONB",
      "Frontend uses React Native\nWhy: one codebase for mobile",
    ],
    [
      "how do we check code style before committing",
      "Run make lint before every commit\nThe CI lint job fails otherwise",
      "The staging cluster runs on AWS us-east-1\nWhere: infra/terraform",
    ],
    [
      "naming convention for workflow identifiers",
      "Airflow DAG ids are snake_case\nWhat: dag ids use snake_case names",
      "User prefers plain declarative sentences\nNo em dashes in docs",
    ],
    [
      "how often do login credentials expire",
      "Auth tokens refresh every 15 minutes\nWhere: services/auth/refresh.ts",
      "Picked Redis for the session cache\nWhy: TTLs and speed",
    ],
  ],
} as const;

export interface BenchMemory {
  key: string;
  text: string;
}

export interface BenchQuery {
  query: string;
  relevant: string;
  kind: "paraphrase" | "no-overlap" | "near-miss";
}

// Harder retrieval benchmark: near-miss distractor clusters plus paraphrase and zero-overlap queries.
export const BENCHMARK: { corpus: readonly BenchMemory[]; queries: readonly BenchQuery[] } = {
  corpus: [
    {
      key: "db-postgres",
      text: "Picked Postgres as the primary database\nWhy: relational joins and JSONB columns",
    },
    {
      key: "db-migrations",
      text: "Database migrations run with drizzle-kit\nWhere: db/migrations, applied on deploy",
    },
    { key: "db-pool", text: "Postgres connection pool max is 20\nWhy: RDS instance caps connections at 100" },
    {
      key: "db-pool-timeout",
      text: "Postgres connection pool idle timeout is 30 seconds\nWhere: db/client.ts",
    },
    {
      key: "db-sqlite-tests",
      text: "Unit tests use in-memory SQLite instead of Postgres\nWhy: faster and no docker needed",
    },
    {
      key: "auth-refresh",
      text: "Auth access tokens refresh every 15 minutes\nWhere: services/auth/refresh.ts",
    },
    {
      key: "auth-keychain",
      text: "Auth tokens are stored in the OS keychain\nWhere: services/auth/store.ts",
    },
    {
      key: "auth-refresh-expiry",
      text: "Refresh tokens expire after 30 days\nUsers must log in again after that",
    },
    {
      key: "auth-oauth",
      text: "OAuth login supports GitHub and Google only\nWhy: enterprise SSO deferred to Q3",
    },
    { key: "ci-lint", text: "Run make lint before every commit\nThe CI lint job fails otherwise" },
    {
      key: "ci-cache",
      text: "CI caches node_modules keyed on bun.lockb hash\nWhere: .github/workflows/ci.yml",
    },
    {
      key: "ci-flaky",
      text: "Flaky e2e test root cause: CI runners share port 3000\nFix: tests pick a random free port",
    },
    { key: "ci-timeout", text: "CI job timeout is 20 minutes\nLonger jobs get killed by GitHub Actions" },
    { key: "deploy-region", text: "Staging cluster runs on AWS us-east-1\nWhere: infra/terraform/staging" },
    { key: "deploy-prod-region", text: "Production cluster runs on AWS eu-west-1\nWhy: GDPR data residency" },
    {
      key: "deploy-friday",
      text: "No production deploys on Fridays\nUser decision after an outage in March",
    },
    {
      key: "deploy-rollback",
      text: "Rollback a bad deploy with make rollback\nIt redeploys the previous image tag",
    },
    { key: "fe-react", text: "Frontend uses React with Vite\nWhy: fast dev server, no Next.js needed" },
    { key: "fe-state", text: "Frontend state lives in Zustand stores\nRedux was removed in 2025" },
    { key: "fe-css", text: "Styling uses Tailwind utility classes\nNo CSS modules in new components" },
    { key: "fe-dark", text: "Dark mode follows the system theme by default\nWhere: src/theme/provider.tsx" },
    { key: "test-runner", text: "Tests run with bun test\nJest was dropped because of slow startup" },
    {
      key: "test-snapshots",
      text: "Snapshot files are committed next to the test\nUpdate them with bun test --update-snapshots",
    },
    { key: "test-coverage", text: "Coverage threshold is 80 percent lines\nCI fails below it" },
    { key: "pipe-airflow", text: "Airflow DAG ids are snake_case\nWhat: dag ids use snake_case names" },
    { key: "pipe-schedule", text: "Nightly ETL DAG runs at 02:00 UTC\nWhy: after upstream exports finish" },
    { key: "pipe-retries", text: "Airflow tasks retry 3 times with 5 minute delay\nSet in default_args" },
    {
      key: "pipe-dedupe",
      text: "Duplicate rows root cause: ETL reran without idempotent upsert\nFix: MERGE on event_id",
    },
    { key: "log-format", text: "Logs are structured JSON via pino\nNever log with console.log in services" },
    { key: "log-level", text: "Default log level is info in production\nDebug only via LOG_LEVEL env var" },
    { key: "log-pii", text: "Never log email addresses or tokens\nA redaction filter strips them in pino" },
    { key: "log-retention", text: "Logs are kept 14 days in CloudWatch\nOlder logs are archived to S3" },
    { key: "pref-editor", text: "User edits in Neovim with LazyVim\nDo not suggest VS Code settings" },
    { key: "pref-indent", text: "User prefers 2-space indentation in TypeScript\nTabs only in Makefiles" },
    { key: "pref-prose", text: "User prefers plain declarative sentences\nNo em dashes in docs" },
    {
      key: "pref-commits",
      text: "Commit messages follow Conventional Commits\nExample: fix(auth): handle expired refresh",
    },
    { key: "pref-pm", text: "User wants bun as the package manager\nNever run npm install in this repo" },
    { key: "cache-redis", text: "Picked Redis for the session cache\nWhy: TTLs and speed" },
    { key: "cache-ttl", text: "Session cache TTL is 24 hours\nWhere: config/cache.ts" },
    {
      key: "api-rate",
      text: "Public API rate limit is 100 requests per minute per key\nReturns 429 when exceeded",
    },
    {
      key: "api-version",
      text: "API versions are in the URL path like /v2/\nHeader-based versioning was rejected",
    },
    {
      key: "api-pagination",
      text: "API list endpoints use cursor pagination\nOffset pagination broke on large tables",
    },
    { key: "sec-secrets", text: "Secrets live in AWS Secrets Manager\nNever commit .env files" },
    { key: "sec-deps", text: "Dependabot opens PRs weekly on Mondays\nSecurity patches are merged same day" },
    {
      key: "obs-alerts",
      text: "PagerDuty alerts fire when p95 latency exceeds 800ms\nThreshold set in monitoring/alerts.tf",
    },
    {
      key: "obs-dashboards",
      text: "Grafana dashboards are defined as code\nWhere: monitoring/dashboards/*.json",
    },
    { key: "search-fts", text: "Search uses SQLite FTS5 with BM25 ranking\nWhy: no extra service to run" },
    {
      key: "email-provider",
      text: "Transactional email is sent through Postmark\nSendGrid had deliverability issues",
    },
    { key: "tz", text: "All timestamps are stored in UTC\nConvert to local time only in the UI" },
    { key: "img-upload", text: "Image uploads are capped at 10 MB\nResized to WebP by a Lambda worker" },
  ],
  queries: [
    { query: "which relational engine backs the app", relevant: "db-postgres", kind: "paraphrase" },
    { query: "how many simultaneous connections can the pool open", relevant: "db-pool", kind: "paraphrase" },
    {
      query: "where are login credentials persisted on the machine",
      relevant: "auth-keychain",
      kind: "paraphrase",
    },
    { query: "which identity providers can people sign in with", relevant: "auth-oauth", kind: "paraphrase" },
    { query: "what happens if a CI job runs too long", relevant: "ci-timeout", kind: "paraphrase" },
    { query: "how do I undo a broken release", relevant: "deploy-rollback", kind: "paraphrase" },
    { query: "what library manages client-side state", relevant: "fe-state", kind: "paraphrase" },
    { query: "what is the minimum test coverage required", relevant: "test-coverage", kind: "paraphrase" },
    { query: "how often do failed Airflow tasks get retried", relevant: "pipe-retries", kind: "paraphrase" },
    { query: "how long are logs retained", relevant: "log-retention", kind: "paraphrase" },
    { query: "how should commit messages be formatted", relevant: "pref-commits", kind: "paraphrase" },
    {
      query: "what happens when a client goes over the API rate limit",
      relevant: "api-rate",
      kind: "paraphrase",
    },
    { query: "where do we keep secrets", relevant: "sec-secrets", kind: "paraphrase" },
    {
      query: "which key-value server holds visitor login state",
      relevant: "cache-redis",
      kind: "no-overlap",
    },
    {
      query: "what region hosts our European live environment",
      relevant: "deploy-prod-region",
      kind: "no-overlap",
    },
    { query: "can I ship changes at the end of the week", relevant: "deploy-friday", kind: "no-overlap" },
    {
      query: "which bundler and view library power the web client",
      relevant: "fe-react",
      kind: "no-overlap",
    },
    { query: "what approach do we take for stylesheet authoring", relevant: "fe-css", kind: "no-overlap" },
    { query: "when does the overnight batch job kick off", relevant: "pipe-schedule", kind: "no-overlap" },
    { query: "which text editor does the person prefer", relevant: "pref-editor", kind: "no-overlap" },
    { query: "should I reach for yarn or pnpm to add dependencies", relevant: "pref-pm", kind: "no-overlap" },
    { query: "which vendor delivers our outgoing mail", relevant: "email-provider", kind: "no-overlap" },
    { query: "maximum picture size people can attach", relevant: "img-upload", kind: "no-overlap" },
    { query: "what clock zone do we save dates in", relevant: "tz", kind: "no-overlap" },
    { query: "who gets paged when responses get slow", relevant: "obs-alerts", kind: "no-overlap" },
    {
      query: "how do we keep personal info out of the server output",
      relevant: "log-pii",
      kind: "no-overlap",
    },
    {
      query: "how long until a refresh token stops working",
      relevant: "auth-refresh-expiry",
      kind: "near-miss",
    },
    { query: "how often are auth access tokens refreshed", relevant: "auth-refresh", kind: "near-miss" },
    {
      query: "what is the idle limit for pooled Postgres connections",
      relevant: "db-pool-timeout",
      kind: "near-miss",
    },
    { query: "which database do unit tests run against", relevant: "db-sqlite-tests", kind: "near-miss" },
    { query: "which AWS region is the staging cluster in", relevant: "deploy-region", kind: "near-miss" },
    { query: "why did e2e tests fail on CI with port conflicts", relevant: "ci-flaky", kind: "near-miss" },
    {
      query: "what is the expiry for entries in the session cache",
      relevant: "cache-ttl",
      kind: "near-miss",
    },
    { query: "why did the nightly ETL produce duplicate rows", relevant: "pipe-dedupe", kind: "near-miss" },
    { query: "what log level do production services default to", relevant: "log-level", kind: "near-miss" },
    { query: "which logging library formats our logs as JSON", relevant: "log-format", kind: "near-miss" },
    { query: "should API versioning go in headers", relevant: "api-version", kind: "near-miss" },
    { query: "do API list endpoints use offset pagination", relevant: "api-pagination", kind: "near-miss" },
    { query: "how do I update committed test snapshots", relevant: "test-snapshots", kind: "near-miss" },
  ],
};
