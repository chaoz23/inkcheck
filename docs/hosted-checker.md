# Hosted checker deployment

The hosted checker lowers the terminal barrier, but it changes the privacy boundary: source is uploaded temporarily to the host. The local CLI remains the safest choice for unpublished or sensitive work.

## Service contract

- Accept ordinary authorized `.ink` files or pasted source through `multipart/form-data`; authors never create an archive, manifest, or JSON bundle.
- Require separate authorization and temporary-processing confirmations.
- Reject absolute, parent-traversing, duplicate, oversized, or non-`.ink` paths.
- Require every `INCLUDE` target to exist inside the uploaded bundle.
- Run Inkcheck in a child process with generous hosted ceilings, a memory ceiling, an output ceiling, and a hard timeout.
- Process one story at a time by default and rate-limit each client address.
- Support a runtime-only pilot access code and a global hourly capacity ceiling.
- Return reports only in the request that created them.
- Never log request bodies, story text, report contents, or final story prose.
- Keep only daily aggregate visit, support-click, completion, rejection, hosted-limit-hit, and duration totals; never persist IP addresses, user agents, request IDs, or visitor profiles.
- Delete the temporary job directory in a `finally` block. Docker stores `/tmp` in memory so a crash cannot create durable story storage.

The report can contain authored choice text, final text, variable names, and values. Treat the report itself as story material.

## HTTP API

`POST /api/check` accepts `multipart/form-data`, the same transport used by ordinary browser file uploads. The main file, optional unchanged `INCLUDE` files, and consent confirmations are separate form parts. Relative project paths travel as hidden part names when a folder is selected; the author does not create or edit that metadata. Browser users do not choose traversal limits; hosted mode uses the service ceilings by default.

For a form hosted on another origin, set `INKCHECK_WEB_ALLOWED_ORIGINS` to an exact comma-separated allowlist such as `https://secondlandings.com`. The API answers browser preflight requests only for configured origins and never emits a wildcard. Command-line and same-origin requests without an `Origin` header continue to work.

The browser offers three source-native choices:

1. upload one main `.ink` file;
2. paste the main file's contents directly; or
3. for a project using `INCLUDE`, add the unchanged supporting files or select the existing project folder.

When pilot protection is configured, the browser sends the code in `X-Inkcheck-Access-Code`. Successful responses contain `{ requestId, report, meta }`; compile and runtime findings are successful reports, not HTTP failures. Validation, capacity, timeout, and internal failures use appropriate 4xx/5xx responses. If a story hits the hosted ceiling after the 10x increase, the API returns a friendly `issueUrl` pointing to GitHub issues and increments the hosted-limit-hit counter. `GET /healthz` returns only service health and version.

`POST /api/event` accepts only `page_view` and `support_click` JSON events from an allowed browser origin. It returns `204` and stores no event-level record. The server immediately folds each event into a UTC daily counter. Completed and rejected checks are counted inside the API, so the browser never reports those separately.

## Production architecture

```text
Internet → Caddy (TLS) → internal Docker network → Inkcheck web container
                                                   └─ ephemeral /tmp job
```

Caddy is attached to public and internal networks. The application is attached only to Docker's `internal` network, so it has no runtime route to the internet or the host LAN. The official inklecate 1.2.1 binary is downloaded and SHA-256 verified while building the image, then baked into the image.

The container runs as a non-root user with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, a 1.5 GiB memory ceiling, one CPU, and a PID ceiling. These controls reduce risk; they are not a substitute for timely host and image updates.

## Deploy on a small VPS

Install Docker Engine and the Compose plugin, point a DNS record at the VPS, then:

```sh
git clone https://github.com/chaoz23/inkcheck.git
cd inkcheck
export INKCHECK_HOST=inkcheck-api.secondlandings.com
export INKCHECK_WEB_ALLOWED_ORIGINS=https://secondlandings.com
export INKCHECK_WEB_ACCESS_CODE='generate-a-long-random-pilot-code'
docker compose up -d --build
docker compose ps
```

Alternatively, copy `.env.example` to `.env` and replace both values. `.env` files are ignored by Git. Generate the pilot code with a password manager or `openssl rand -base64 32`; never commit or paste the real value into an issue or pull request.

Caddy obtains and renews TLS certificates automatically. Do not expose the Inkcheck container's port directly. Permit inbound TCP 80/443 and UDP 443; keep administrative SSH restricted by key and source address where possible.

The Compose deployment keeps aggregate counters in the `inkcheck_usage` volume. The file contains only daily totals, is pruned to 400 days, and survives container rebuilds. Caddy access logging is disabled so source addresses and user agents are not retained; bounded application and operational logs remain available through Docker.

Update with:

```sh
git pull --ff-only
docker compose up -d --build
docker image prune -f
```

Install the unattended weekly report once after the first metrics-enabled deployment:

```sh
sudo ./deploy/install-usage-timer.sh
```

The systemd timer runs each Monday at 09:00 UTC, catches up after downtime, and writes `/var/log/inkcheck/usage-latest.txt` plus an append-only `/var/log/inkcheck/usage-history.txt`. It needs no API key, third-party analytics account, or AI service. Inspect it at any time with:

```sh
cat /var/log/inkcheck/usage-latest.txt
systemctl list-timers inkcheck-usage-report.timer
```

To generate an arbitrary window without changing the timer:

```sh
docker compose exec -T inkcheck node dist/usage-report.js --days 30
```

## Default limits

| Control | Default |
| --- | ---: |
| Request body | 5 MiB |
| Files | 200 |
| Individual file | 2.5 MiB |
| Maximum choice depth | 1,000 |
| Maximum states | 50,000 |
| Check timeout | 450 seconds |
| Concurrent checks | 1 |
| Checks per client | 10 per hour |
| Checks across the service | 60 per hour |
| Report output | 80 MiB |

Environment variables in `compose.yaml` can lower these values if measured abuse or cost pressure appears. Keep the public UI free of traversal controls unless real community usage proves authors need them.

## Monthly budget ceiling

Pricing checked July 7, 2026:

| Item | Planned monthly cost |
| --- | ---: |
| DigitalOcean Basic Droplet, 2 GiB RAM / 1 vCPU | $12.00 |
| Weekly Droplet backup (20% of compute) | $2.40 |
| Domain allowance (budgeted at $20/year) | $1.67 |
| Cloudflare free DNS/CDN, optional | $0.00 |
| Monitoring using provider metrics and the `/healthz` endpoint | $0.00 |
| **Planned total before tax** | **$16.07** |
| **Headroom under $50 ceiling** | **$33.93** |

DigitalOcean publishes flat Basic Droplet prices and a 20% weekly-backup option: <https://www.digitalocean.com/pricing/droplets>. Cloudflare publishes a $0 free plan: <https://www.cloudflare.com/plans/free/>. Domain prices vary; the allowance is a budget rather than a vendor quote.

If measured memory pressure requires 2 vCPUs, DigitalOcean's 2 GiB / 2 vCPU plan is currently $18/month, keeping the planned total below $25 before tax.

## Windows PC role

Use the local Windows PC for Docker Desktop development, synthetic load tests, staging, and emergency report reproduction. Do not make it the default public host on residential Comcast service. Comcast's residential acceptable-use policy restricts public servers and outside-LAN services, with only an ambiguous personal/noncommercial exception: <https://www.xfinity.com/corporate/customers/policies/highspeedinternetaup>.

Keeping public uploads off the home LAN also avoids exposing household devices to the service's trust boundary. A private Windows staging instance should bind only to localhost or remain behind authenticated access.

With Docker Desktop using Linux containers, a safe localhost-only smoke test is:

```powershell
docker build -t inkcheck-hosted:test .
docker run --rm -p 127.0.0.1:8080:8080 -e INKCHECK_WEB_ACCESS_CODE=local-test-only inkcheck-hosted:test
```

Open `http://127.0.0.1:8080`, use `local-test-only` as the access code, and test only synthetic or public fixtures. Do not add router port forwarding.

## Pilot operations

1. Deploy with a long random `INKCHECK_WEB_ACCESS_CODE` and test only synthetic/public fixtures.
2. Confirm temporary directories disappear after success, compilation failure, runtime failure, timeout, and client disconnect.
3. Run a three-to-five-author opt-in pilot.
4. Review false positives, incompatible host integrations, peak memory, latency, and support burden.
5. Expand only if the service remains useful within the fixed limits and budget.

Do not promise exhaustive coverage. `EXTERNAL` functions, engine-entered knots, randomness, and bounded traversal remain visible limitations in hosted mode.
