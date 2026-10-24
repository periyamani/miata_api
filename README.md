# miata-api — MIATA backend

REST API for **MIATA — Medical Imaging Accredited Training Academy** (PG Diploma in Ultrasound, clinical training, ARDMS
preparation). It serves the four role portals of [miata-web](../miata-web) — **Admin, Agent, Professor, Student** — and the
website's contact form.

Node.js · Express 5 · PostgreSQL (managed with pgAdmin 4) · JWT sessions · role-based and record-level authorisation.

## Requirements

| Tool | Version |
|---|---|
| Node.js | 20.11 or newer (developed on 22) |
| PostgreSQL | 14 or newer (developed on 18) |
| pgAdmin 4 | Any recent version (installed with the PostgreSQL Windows installer) |

## Setup

```bash
cd miata-api
npm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env` (it is git-ignored; never commit real credentials). The server refuses to start if a required value is missing or
invalid, and names the variable.

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_SSL` | Your PostgreSQL server — the same connection you use in pgAdmin |
| `LIVE_DB_NAME` | **Live** database — the actual application data (default `miata_live_db`) |
| `MOCK_DB_NAME` | **Mock** database for development and testing (default `miata_mock_db`) |
| `DATA_SOURCE` | `live` (default) or `mock`. `npm run dev:mock` selects mock without editing the file. Mock is refused in production. |
| `JWT_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `FRONTEND_URL` | Public URL of miata-web (default `http://localhost:5173`): CORS origin and the base of links in emails (reset, referral, login) |
| `CORS_ORIGINS` | Extra allowed origins, comma separated |
| `COOKIE_SAMESITE`, `COOKIE_SECURE` | Refresh-cookie policy. `lax` when web and API share a site; `none` (HTTPS only) when they are on different domains |
| `PORT`, `NODE_ENV`, `TRUST_PROXY` | Server port (5000), environment, and `true` behind a reverse proxy |
| `UPLOAD_DIR`, `MOCK_UPLOAD_DIR` | Upload folders for live and mock data (`./uploads`, `./uploads-mock`) |
| `MAX_VIDEO_SIZE_MB`, `MAX_DOCUMENT_SIZE_MB` | Upload limits (1024 / 20) |
| `SMTP_*`, `EMAIL_FROM`, `ENQUIRY_NOTIFY_EMAIL` | E-mail: welcome / set-password links for new accounts, online class invitations, updates and cancellations, password resets, enquiry notifications. Without `SMTP_HOST`, e-mails are recorded as "skipped" (set-up and reset links are then printed to the dev console) and admins must give new accounts a temporary password |
| `APP_TIMEZONE` | IANA time zone for dates and times in e-mails, e.g. `Asia/Kolkata` (default: the server's time zone). Also decides when a day ends for course access periods |
| `ACCESS_EXPIRY_CHECK_MINUTES` | How often the API deactivates students whose course access period has ended (default 60; they are also checked at every sign-in) |

## Databases: live and mock are separate

There are exactly two databases: `miata_live_db` (live) and `miata_mock_db` (mock). Nothing ever copies data between them.

```bash
# Live data — creates LIVE_DB_NAME if missing and applies database/migrations
npm run db:setup
npm run create-admin          # first Admin account (asks for name, email, hidden password)

# Mock data — creates MOCK_DB_NAME and loads database/mock-data (never touches the live database)
npm run db:mock               # first load
npm run db:mock -- --reset    # drop and reload the mock data
```

- The live database starts empty. Admins exist only through `create-admin`; they then create professors, agents and students
  (who must choose their own password at first sign-in). Students can also self-register through the website.
- Mock data lives in [`database/mock-data`](database/mock-data) (one JSON file per table + upload files). Every mock account
  uses the password **`Miata-6C75DR9`** — e.g. `admin@miata.local`, `ramesh.agent@miata.local`, `robert.wilson@miata.local`,
  `arun.kumar@miata.local`. The full list is in [docs/database.md](docs/database.md#mock-data).
- Each data source has its own upload folder, so mock files never mix with live ones.
- `npm test` runs against the mock database: it rebuilds the schema for each test file and reloads the mock data when the
  run ends, so anything changed by hand in `miata_mock_db` is replaced.
- In pgAdmin 4: connect to your server and open **Databases → miata_live_db** (or `miata_mock_db`) **→ Schemas → public → Tables**.

Details — migrations, tables, relationships, how the existing data was migrated, consistency checks: [docs/database.md](docs/database.md).

## Run

```bash
npm run dev          # live data, http://localhost:5000, restarts on changes
npm run dev:mock     # mock data
npm start            # production-style start (live data)
npm run start:mock   # mock data without file watching
```

The startup log names the database in use, e.g. `Connected to PostgreSQL database "miata_mock_db" (mock data)`.
`GET /api/health` returns `{ status, database }`. The API runs on its own; miata-web talks to it over REST.

## Scripts

| Command | What it does |
|---|---|
| `npm run db:setup` / `npm run migrate` | Create the selected database if needed and apply pending migrations (`--mock` targets the mock database) |
| `npm run db:mock [-- --reset]` | Load the mock data into `MOCK_DB_NAME` and its files into `MOCK_UPLOAD_DIR` |
| `npm run db:seed [-- --reset]` | Same as `db:mock` — seeds `MOCK_DB_NAME` with the sample data in `database/mock-data` |
| `npm run db:compare -- <dbA> <dbB>` | Compare two databases table by table: row counts, row checksums, duplicates |
| `npm run create-admin` | Create an Admin (interactive; `-- --non-interactive` with `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` for automation) |
| `npm test` | 168 integration + unit tests against `MOCK_DB_NAME`, then reloads the mock data |
| `npm run lint` · `npm run format` | ESLint · Prettier |

## Project structure

```
miata-api/
├── database/
│   ├── migrations/          001_functions … 016_course_lecturers (SQL, applied in order)
│   └── mock-data/           tables/*.json + uploads/ — development data only
├── docs/                    api.md (every endpoint), database.md (schema, data sources)
├── scripts/                 db-setup, load-mock-data, compare-databases, create-admin, run-tests
├── src/
│   ├── config/              env validation (data source selection), PostgreSQL pool, migration runner
│   ├── middleware/          authenticate/authorize, validate (zod), upload, rate limits, errors, request log
│   ├── modules/             auth, profile, notifications, media, enquiries, users,
│   │                        admin/* (courses, enrolments, teaching, people, referrals, assignments, videos, settings, …),
│   │                        agent, professor, student — each *.routes → *.controller → *.service → *.repository
│   ├── repositories/        SQL shared between roles + scope predicates (who may see which records)
│   ├── services/            completion, progress, tokens, e-mail, storage, notifications, activity, settings
│   ├── utils/  validators/
│   └── app.js  routes.js  server.js
└── tests/                   node:test + supertest
```

## API overview

All endpoints are under `/api`; responses are JSON (`{ data }`, with `meta` on lists; errors `{ error: { code, message, details? } }`).
Full reference: [docs/api.md](docs/api.md).

| Area | Prefix | Who |
|---|---|---|
| Health, sign-in, registration, password reset, referral lookup | `/api/health`, `/api/auth/*` | public |
| Website contact form | `POST /api/enquiries` | public |
| Own profile, notifications, video streaming | `/api/profile`, `/api/notifications`, `/api/media` | any signed-in user |
| Management | `/api/admin/*` | admin |
| Referrals, Apply Now | `/api/agent/*` | agent (own referrals only) |
| Teaching | `/api/professor/*` | professor (assigned courses/modules only) |
| Learning, fees and payment proofs | `/api/student/*` | student (own enrolments only) |

**Role login.** miata-web's login page has one login per role. It sends `role` with `POST /api/auth/login`; an account of a
different role is refused with `403 ROLE_MISMATCH` (after the password check, so the role of an unknown password is never
revealed) and no session is created. Every `/api/<role>` namespace also checks the role on each request, and every query is
scoped to the caller's records — the frontend only hides navigation.

**Sessions.** 15-minute access JWT kept in memory by the client; rotating, hashed refresh token in an httpOnly cookie
(`miata_rt`, path `/api/auth`) with reuse detection; `token_version` revokes every session at once (logout everywhere,
password change, deactivation, course completion).

## Security summary

bcrypt password hashing · short-lived access tokens · rotating httpOnly refresh cookies with reuse detection · role guard on
every namespace plus record-level scoping in every query · zod validation on every input · parameterised SQL only (sort
columns whitelisted) · upload checks on extension, MIME type and file signature · helmet headers · CORS allow-list · rate
limits on sign-in, registration, password reset and public forms · generic error responses (details only in server logs) ·
CSV exports protected against formula injection · full activity log.

## Production checklist

- Serve over HTTPS; refresh cookies are `Secure` in production. If miata-web is on another domain, set `COOKIE_SAMESITE=none`.
- Set `NODE_ENV=production`, `FRONTEND_URL` (and `CORS_ORIGINS` if needed) to the public URLs; `TRUST_PROXY=true` behind a proxy.
- Back up the PostgreSQL database **and** `UPLOAD_DIR` together.
- Rate limits are kept in memory per process; with several instances, use a shared store for `express-rate-limit`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to PostgreSQL` | Check the `DB_*` values against what works in pgAdmin, and that the PostgreSQL service is running. |
| `Database schema is out of date` | `npm run db:setup` (live) or `npm run db:mock` (mock). |
| `Invalid environment configuration` | The message names the variable — usually `JWT_SECRET` (min 32 characters). |
| `Refusing to load mock data into the live database` | `MOCK_DB_NAME` must differ from `LIVE_DB_NAME`. |
| "Too many login attempts" | The sign-in rate limit; wait 15 minutes, or restart the API in development. |
| Signed out right after signing in (production) | Plain HTTP with `Secure` cookies — use HTTPS. |

Development plan, module structure and pending work: [PLAN.md](PLAN.md).
