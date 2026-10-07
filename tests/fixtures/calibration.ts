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
