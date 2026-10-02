# Load testing (k6)

Phase 5.4 load/spike scenarios for the portal's hot paths.

## Run

```bash
# install once
brew install k6        # or: choco install k6 / apt install k6

# steady bell-rush + spike (uses the scenarios in portal.js)
k6 run -e BASE=http://127.0.0.1:8080 apps/api/loadtest/portal.js

# quick smoke against a running stack
k6 run --vus 20 --duration 30s -e BASE=http://127.0.0.1:8080 apps/api/loadtest/portal.js
```

Both servers must be up first (`npm start -w @portal/api` and `npm start -w @portal/web`),
seeded with the default demo accounts (`Passw0rd!`).

## What it exercises

- **student** (50%): login (no MFA) → grades, attendance, exams reads
- **parent** (30%): login → children list → per-child grades/fees/transport reads
- **teacher** (20%): login → TOTP enrol+verify (a real RFC-6238 code is computed in-script)
  → sections → gradebook read

## Scenarios & thresholds

- `steady`: ramp to 50 VUs, hold 1m, ramp down — models normal traffic.
- `spike`: arrival-rate spike to 300 req/s at 02:10 — models whole-school login at bell.
- Thresholds (single-node dev box; tighten for prod SLOs):
  - `http_req_failed < 1%`
  - `http_req_duration p(95) < 600ms`
  - `checks > 98%`

## Notes

- Teacher flows enrol a fresh TOTP factor per VU iteration (the seed staff have 2FA);
  the script computes the code itself so no external authenticator is needed.
- Against PGlite (dev) numbers are not representative of Neon/Supabase — run the real
  benchmarks against the managed Postgres in eu-west-1 before trusting absolute latency.
