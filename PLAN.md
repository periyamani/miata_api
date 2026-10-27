# miata-api — development plan

## Goal

One REST API for the MIATA website and the four role portals, on PostgreSQL, with live data and mock data kept
strictly apart in two databases (`miata_live_db`, `miata_mock_db`). miata-web is the only client; both run and deploy independently.

## Module structure

| Layer | Folder | Responsibility |
|---|---|---|
| Routes | `src/modules/**/*.routes.js` | URL, validation schema, role guard |
| Controllers | `*.controller.js` | HTTP in/out only |
| Services | `*.service.js`, `src/services/` | Business rules, transactions, notifications, activity log |
| Repositories | `*.repository.js`, `src/repositories/` | Parameterised SQL; `scope.js` holds the "who may see what" predicates |
| Config | `src/config/` | Environment + data source selection, pool, migration runner |
| Database | `database/migrations`, `database/mock-data` | Schema history; development data |

Modules: `auth`, `profile`, `notifications`, `media` (signed video streaming), `enquiries`, `users`,
`admin/{courses, batches, enrolments, payments, teaching, accounts, students, professors, agents, referrals, assignments, videos, settings,
activity, lookups, dashboard}`, `agent`, `professor`, `student`.

## Role-based access

| Capability | Admin | Agent | Professor | Student |
|---|---|---|---|---|
| Courses, modules, lessons, enrolments, professor assignment | ✔ | | | |
| Batches: create / courses / professors / students / material availability | ✔ | | own batches (view) | own batch (view) |
| Create / deactivate students, professors, agents | ✔ | | | |
| Reassign referral ownership | ✔ (logged) | | | |
| Referred students | all | own only | | |
| Students | all | own referrals | own batches' students; unbatched students of assigned courses/modules | self |
| Assignments: create / edit / publish (assign) / delete | view only | | assigned scope only: course-wide, or for own batches (whole batch or selected students) | published, set for them |
| Review submissions (comment, Completed / Rework) | view only | | students they teach | |
| Submit / resubmit, comment on own submission | | | | own, enrolled, when allowed |
| Videos: upload / publish · watch | ✔ · preview | | assigned courses | enrolled + published + available to their batch |
| Enquiries, completion policy | ✔ | | | |
| Register a referred student (Apply Now) | (creates students directly) | attributed to themselves | | |
| Course fees, discounts, access periods | ✔ | | | own (view) |
| Upload a payment proof | | | | own enrolments |
| Verify payments (approve / reject / back to pending) | ✔ (logged) | | | |

Enforced by the namespace guard (`/api/<role>`), record-level scoping in each query (out-of-scope records return 404), and
the role chosen on the login page (`ROLE_MISMATCH`).

## Business rules (decisions recorded)

1. One role per account. Admins only through `create-admin`; admin-created accounts must choose their own password before signing in: they are e-mailed their account details and a single-use set-password link (72 h). The admin may also set a temporary password to hand over in person (required without SMTP). Passwords are never e-mailed.
2. Referral attribution at registration (`?ref=CODE`) or by an admin; one agent per student (unique in the database); only admins reassign, always logged.
3. Referral/student status is derived from records (`student_status` view): inactive › active › completed › pending.
4. Course completion is decided only by the server, from the completion policy (`app_settings`): required published videos watched to the threshold (default 90%, credited from heartbeats capped by real time) and required published assignments marked Completed. A course without requirements never completes.
5. On completion: enrolment completed, activity log, notifications; by default every session ends and the next sign-in requires a new password (single-use 30-minute token).
6. Enquiries are stored first, then the notification e-mail is attempted; the real outcome (`sent` / `failed` / `skipped`) is stored.
7. Assignments belong to professors: a course professor manages every assignment of the course, a module professor only their module's. Admins monitor assignments and submissions read-only (`/api/admin` write routes answer `403`).
8. Submission lifecycle (enforced in the services and by a database trigger): `submitted → in_review → completed | rework`. Only the latest attempt is reviewed, once. After rework the student uploads a new attempt; `completed` closes the assignment for that student.
9. Files are stored on disk under random names; metadata only in `files`; downloads only through authorised routes, videos through 2-hour signed URLs.
10. Online classes: a batch's professors schedule Google Meet / Zoom classes (https links on `meet.google.com` or `*.zoom.us` only) for the whole batch or selected students of it; only that audience sees the class and its link. Each affected student is e-mailed (and notified in-app) once per change: invitation, update (with what changed), "no longer scheduled for you" when removed from the audience (without the new link), cancellation. Saving without changes sends nothing. Classes are cancelled, never deleted; admins monitor them read-only.
11. Person-to-person e-mails go through the `email_deliveries` outbox: queued in the same transaction as the change, sent after commit with exactly one recipient each, outcome stored. A unique dedupe key prevents duplicates; failed or skipped e-mails can be resent.
12. Batches are cohorts: a batch takes courses, has its own professors and students (one batch per student). Course access stays with enrolments — adding students or courses to a batch enrols the students; leaving a batch keeps enrolments, submissions and progress. A student's enrolment in a course their batch takes belongs to the batch's professors only; other enrolments stay with the course/module professors (so nothing changes until batches are used). Assignments are course-wide, for one batch, or for selected students of a batch; modules and videos are available to every batch unless restricted. Progress and completion count only what applies to the student. Batches are deactivated, and deleted only when empty. The rules are SQL functions (migration 010) used by `enrolment_progress` and `scope.js`.
13. Course access periods: every enrolment has a start date (the batch's start date when taken with a batch that has one, else the enrolment day) and an end date (start + course duration − 1 day; none for a course without a duration), set by a trigger and editable by admins. A student's access ends on the latest end date of their enrolments; the day after (in `APP_TIMEZONE`) the API deactivates the account (`deactivated_reason = course_expired`) at start-up, every `ACCESS_EXPIRY_CHECK_MINUTES` and at sign-in, ends its sessions, logs it and notifies the admins. Each end date deactivates an account once, so an admin's reactivation stands until a later end date passes; extending an end date reactivates an account deactivated only by expiry. Students without enrolments never expire.
14. Agent applications (Apply Now): an agent registers a referred student exactly like an admin-created account (welcome e-mail with a set-password link, or a temporary password without SMTP), attributed to that agent only (`source = agent`), with the course applied for and a note. Enrolment and batches stay with admins, who are notified.
15. Fees: a course has a standard fee, copied to each new enrolment; admins set each student's fee and discount (scholarship). Students report payments with a proof (png / jpg / webp / pdf), up to the balance less payments awaiting verification. Admins approve, reject (with a note the student sees) or set a decision back to pending; only approved payments count as paid. Paid, pending and balance are derived (`enrolment_fees` view), never stored. Enrolments with payments cannot be deleted. Every decision is logged with the previous status and the student is notified.
16. Course timetables live in the course structure (migrations 015, 016), not in separate tables: the course has its academic year, start and end dates (week 1 begins on the start date) and timetable notes; `course_lecturers` its lecturer allocations (name exactly as on the timetable, optional professor account, allocation, day, start / end time, session length); a module is a curriculum module; a lesson is a curriculum topic or — with a programme week and a course lecturer — a weekly session. Week dates and "module complete" weeks are derived (`GET /admin/courses/:id/timetable`). Built-in timetables are imported from the Courses page: a preview (dry run) first, modules matched by exact title or mapped by the admin (similar titles only suggested), lecturers by name, professor accounts linked only on a unique name match (never created), sessions by module + week + lecturer, topics by title; only empty fields are filled, nothing is duplicated. The 2026–2027 MIATA Postgraduate Sonography template copies the curriculum PDF (14 modules, 212 topics; cardiac kept in the catalogue, never scheduled) and the revised timetable (5 lecturers, 96 sessions, the nerve module) verbatim; sessions whose module is a judgement call and what the documents do not state (times, course code and category, a fixed weekday for Dr. Bagyavasan) are listed for review.
17. Module status (migration 017): the professors who teach a module — its course's professors, or the module's own — mark it Not Started, In Progress or Completed from their dashboard; admins see it, with who set it and when, on the course's curriculum. One status per module (shared by every batch taking the course); no row = not started; each change is logged.

## Implementation steps

| # | Step | Status |
|---|---|---|
| 1 | Config, pool, migration runner, error handling, logging | Done |
| 2 | Auth: login, refresh rotation, logout, registration with referral, forgot/reset, forced reset | Done |
| 3 | Admin modules: people, courses/curriculum, enrolments, teaching scope, referrals, assignments, videos, enquiries, settings, activity, dashboard | Done |
| 4 | Agent, professor and student APIs with record-level scoping | Done |
| 5 | Completion and progress services, signed media streaming, notifications, e-mail | Done |
| 6 | Restructure into `miata-api` (API only — the website is now served by miata-web) | Done |
| 7 | Role-specific login (`role` on `POST /auth/login`, `ROLE_MISMATCH`) | Done |
| 8 | Migrations split by concern (functions, tables, relationships, constraints, indexes, triggers, views, reference data); verified identical to the old schema | Done |
| 9 | Data sources: live / mock databases and upload folders; mock data exported to `database/mock-data`; loader, comparison script | Done |
| 10 | Existing data migrated (old database → mock files → mock database); verified identical with `db:compare` | Done |
| 11 | Tests: 92 passing (auth incl. role login, access control, assignments, completion, videos, enquiries, rate limits, mock data, units) | Done |
| 12 | Verification on a copy of the live database: CRUD across every entity through the API and the four dashboards in the browser | Done |
| 13 | Naming: project `miata`; exactly two databases `miata_live_db` (`LIVE_DB_NAME`) and `miata_mock_db` (`MOCK_DB_NAME`); tests run on the mock database and reload the mock data afterwards; old `miata_lms*` databases removed | Done |
| 14 | Assignment authoring moved from admins to professors (scoped to their courses/modules); admins read-only; submission status transitions enforced by migration 009 | Done |
| 15 | Batch-wise workflow (migration 010): admin batch management (courses, professors, students, material availability, batch-wise tracking), batch professors and batch / selected-student assignments, students limited to their batch's material; integrated into the existing admin, professor and student screens. Tested by tests/batches.test.js (19 tests) and end to end in the browser for every role on mock data | Done |
| 16 | Online classes and e-mail notifications (migration 012): professors schedule / update / cancel Google Meet or Zoom classes per batch or selected students; students see and join them; admins monitor; welcome e-mails with set-password links; `email_deliveries` outbox with dedupe and resend. Tested with a local SMTP sink (tests/meetings.test.js) and end to end on mock and live data | Done |
| 17 | Fees, payment proofs, course access periods and agent applications (migration 013): automatic deactivation when a student's course access ends (periodic check + sign-in), admin access-period and fee editing, student Fees & Payments page with proof upload, admin Fee Payments verification (approve / reject / back to pending) with proof preview, agent Apply Now. Tested by tests/fees-access.test.js (19 tests) and the mock-data test; verified end to end in headless Chrome for the agent, student and admin flows on mock data | Done |
| 18 | Course timetables (migration 015): academic year, dates and notes on courses, programme week on lessons, timetable import; the separate `timetable*` tables of the withdrawn 014 dropped after a backup (they were empty). Table audit: every other table is in use. | Done |
| 19 | Course lecturers and the full curriculum (migration 016): `course_lecturers` (lecturer columns moved off modules, data-preserving), sessions as lessons with week + lecturer in their curriculum module, `GET /admin/courses/:id/timetable` (week / module / lecturer filters), lecturer CRUD, import with dry-run preview, module mapping, professor matching and a categorised summary. Tested by tests/course-timetable.test.js (16 tests) and the mock-data test; verified in headless Chrome (41 checks); imported into `miata_mock_db` (course 7) | Done |
| 20 | Lecturers as professors: the 2026–2027 lecturers' professor accounts created in the mock data and `miata_mock_db` (after a backup; nothing deleted) and linked; linked lecturers become the professors of the modules they teach (on link, lesson save and import, only added); module professors restricted to a course's lecturers (`422`); the import summary reports assignments and non-lecturer module professors; `GET /professor/timetable` and `GET /student/timetable` (module availability applied, no account details). Tested by tests/course-timetable.test.js (21 tests) and the mock-data test (168 in total); verified in headless Chrome across the four portals (28 checks) | Done |
| 21 | Module status (migration 017): `module_statuses`, `GET /professor/modules`, `PUT /professor/modules/:moduleId/status`, teaching status on the admin curriculum, sample statuses in the mock data. Tested by tests/module-status.test.js (9 tests) and the mock-data test (178 in total, on a scratch database); verified in headless Chrome for admin and professor, desktop and phone width | Done |
| 22 | Mock data cleanup: the mock data now holds only the accounts the application needs — 1 admin, the five timetable lecturers as professors, the five active enrolled students, 2 agents — and every course, module, lesson (212 topics, 96 sessions), course lecturer, module status, video and batch. Removed (after backups, in one checked transaction): the demo professors Robert Wilson, Anjali Mehta and Samuel Lee and the students Vikram, Karthik and Rahul, with their assignments, submissions, reviews, online classes, e-mails, enrolments, payments, activity entries and files, and the six sample enquiries. `miata_mock_db` reloaded from the cleaned files (it held leftover test fixtures). Verified: account counts, academic data identical, dry-run re-import of the PDF timetable finds nothing to change, 179 tests, headless Chrome across the four portals (41 checks), restart and re-seed add nothing, live database unchanged | Done |

## Pending tasks / next steps

- **Live admins**: the live database (at 017) has two admin accounts, `admin@miata.local` (14 Oct) and `miata.admin@gmail.com`
  (25 Oct); deactivate the one that is not wanted.
- **Live timetable**: the live database has no courses yet. Import the 2026–2027 timetable from Courses › Import
  Timetable (enter the real course code), then create the five lecturers' professor accounts with their real e-mail addresses
  ("Create account" on the Weekly Timetable tab links each one and assigns their modules).
- **To confirm with MIATA** (not in the documents): session start / end times, the course code and category, a fixed weekday for
  Dr. Bagyavasan, the 8 sessions placed in a module by judgement (listed in the import preview), and whether the existing
  "PG Diploma in Ultrasound" course is the same programme, and the lecturers' real e-mail addresses.
- **Mock data gaps** (not invented): no student is enrolled in MIATA Postgraduate Sonography, and the original courses and the
  batches have no professors, so their students have no assignments or online classes. Enrol students / assign professors from
  the Admin portal if wanted.
- **SMTP**: configure `SMTP_*` (and `APP_TIMEZONE`) and send a test through the real mail server. Every e-mail (welcome / set-password, online class invitations, updates, cancellations, reset, enquiry) is verified end to end through nodemailer against a local SMTP sink, but not yet against the production mail server (deliverability: SPF / DKIM for `EMAIL_FROM`'s domain).
- **Hosting**: decide the deployment layout (same site with a reverse proxy, or separate domains with `COOKIE_SAMESITE=none` over HTTPS).
- Shared rate-limit store (e.g. Redis) if more than one API instance will run.
- Optional: e-mail students when a payment is approved or rejected and before their access ends (today these are in-app notifications and a dashboard warning); let admins record payments received offline (cash at the office) without a student upload.
- Optional: move uploads to object storage — re-implement `src/services/storage.service.js` (callers only use storage keys).
