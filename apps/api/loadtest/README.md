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

## Profiles

`PROFILE=full` (default) — the measurement:

- `steady`: ramp to 50 VUs, hold 1m, ramp down — models normal traffic.
- `spike`: arrival-rate spike to 300 req/s at 02:10 — models whole-school login at bell.
- Thresholds (single-node dev box; tighten for prod SLOs):
  - `http_req_failed < 1%`
  - `http_req_duration p(95) < 600ms`
  - `checks > 98%`

`PROFILE=ci` — the gate that runs on every push (`.github/workflows/ci.yml`,
job `loadtest`):

- 10 VUs for 45s, no spike.
- Same error and check thresholds; `p(95) < 3000ms` instead of 600ms.

The looseness is deliberate and the reason is worth stating: a GitHub runner
hosts the API, the database and the load generator in one 2-core container,
so it cannot measure a production SLO. A gate that fails on runner noise is
one that gets disabled inside a fortnight. CI therefore asserts what CI can
honestly assert — the script still drives every hot path, essentially nothing
errors, and latency has not fallen off a cliff. Both profiles execute the same
script, so it cannot rot between manual runs.

## Rate limits

The profile logs in on every iteration, which trips the production login
throttles on purpose. The target must be started with load-test ceilings:

```bash
RATE_LIMIT_LOGIN_MAX=1000000 RATE_LIMIT_LOGIN_IP_MAX=1000000 \
RATE_LIMIT_ACCT_OPS_IP_MAX=1000000 RATE_LIMIT_GENERAL_MAX=1000000 \
RATE_LIMIT_TOTP_MAX=1000000 SEED_DEMO=true node apps/api/dist/main.js
```

The throttles themselves are asserted in the phase-6 hardening and phase-7
suites — this gate measures throughput, not brute-force defence.

## Notes

- Teacher flows enrol a fresh TOTP factor per VU iteration (the seed staff have 2FA);
  the script computes the code itself so no external authenticator is needed.
- Against PGlite (dev) numbers are not representative of Neon/Supabase — run the real
  benchmarks against the managed Postgres in eu-west-1 before trusting absolute latency.
