# Legacy cron services

## Status

The Railway services `kdc-reset-cron` and `kdc-report-cron` originated during development of the Kitchen Daily Checks hospitality application.

### `kdc-reset-cron`

- Status: deferred legacy infrastructure.
- Current Railway observation: a schedule exists, but there is no active deployment.
- Current operational dependency: none for Talk.Get OS or Helping Hand development.
- Action: do not restart, redeploy, or fine-tune automatically.
- Retention reason: preserve the former daily-task-reset responsibility until it is deliberately retired or reassigned within the future DC/Helping Hand automation architecture.

### `kdc-report-cron`

- Status: legacy application infrastructure still deployed in Railway.
- Historical responsibility: generate daily report emails through Resend.
- Current operational dependency: not established for Talk.Get OS or Helping Hand development.
- Action: retain without expanding its role until a separate review determines whether to retire it or absorb its responsibility into the future architecture.

## Decision boundary

Neither cron service is part of the completed production schema migration. The absence of an active reset-cron deployment is not a migration failure. Any future restart, redeployment, retirement, deletion, or transfer of responsibility requires a separate explicit decision and verification of downstream dependencies.
