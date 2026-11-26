# Load test

Measures how much one GitQuire container carries: people editing one page, a normal day in one
wiki, big wikis, many wikis open, and a slow or unreachable Git host. Every scenario also checks
that no edit is lost: all clients end with the same page, the server has every edit, and the Git
host has it after the next push.

It runs on GitHub's standard runners (`.github/workflows/loadtest.yml`): weekly on Sunday night,
the soak once a month, and by hand from the Actions tab. It never runs on pull requests. The
container is limited to 2 CPUs and 4 GB; the load generator, the GitHub fake and the sampler use
the runner's other two CPUs. No load ever goes to github.com: people sign in through the GitHub
fake in `.github/prototypes/github-fake.mjs`.

## Scenarios

| | Scenario | Levels |
| --- | --- | --- |
| s0 | Idle footprint | wiki of 100 and 5,000 pages |
| s1 | One page, many editors | 2, 5, 10, 20, 40 people typing in one page |
| s2 | One wiki, normal day | 10, 25, 50, 100 people; a fifth typing, the rest reading, searching, opening backlinks |
| s3 | Big wiki | 1,000 / 5,000 / 20,000 pages with as many commits; rename of a page with 200+ backlinks |
| s4 | Many wikis | 1, 5, 10, 20, 40 wikis open, three people each |
| s5 | Drafts | 1, 5, 10, 20 drafts in use, one person typing in each, five people on the live wiki; then a publish |
| s6 | Git under load | 25 people while the host answers after 0, 0.5 and 3 s, and while it is down for two minutes |
| s9 | Soak | 20 people for five hours |

A level passes under the limits in `lib/verdict.mjs`: edits seen by others within 500 ms (p95),
pages open within 1 s, API answers within 0.8 s (search, backlinks and link graph 1.5 s), saved to
the host within 2 minutes, memory under 85 % of the limit, fewer than 0.5 % errors and no lost
edit. A scenario stops at the first level that fails. The scale claim is the last level that
passes, per scenario.

## Results

Each run uploads the JSON and `report.md` as artifacts and writes the report into the run's
summary. Scheduled runs, and runs started by hand on `main`, also store them on the
`perf-results` branch (`latest/` and `runs/<date>-<commit>/`); the next run compares against
`latest/` and lists every value that got more than 30 % worse.

## Running it yourself

```bash
pnpm install
docker build -t gitquire:ci .
mkdir -p /tmp/ca && cd /tmp/ca
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout key.pem -out cert.pem
openssl genrsa -out app.pem 2048 && cd -
NODE_EXTRA_CA_CERTS=/tmp/ca/cert.pem node loadtest/run.mjs --scenario s1 --quick --hold 30
node loadtest/report.mjs
```

`--quick` runs the first levels only. `LOADTEST_TARGET=local` runs `gitquire front-door` from the
built CLI instead of the image, for working on the harness itself; its numbers are not comparable.
