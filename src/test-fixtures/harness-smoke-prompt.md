# Plan Reviewer harness smoke

Inputs:
- Plan ID: {{PLAN_ID}}
- Service URL: {{SERVICE_URL}}
- Runner script: {{RUNNER_PATH}}

Immediately run this exact command from the repository root:

```bash
bash {{RUNNER_PATH}}
```

Do not inspect files first. Do not rewrite the script. Do not ask for manual intervention. Print the command output. The run is complete only when the script prints `ACKED=2`.
