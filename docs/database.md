# MIATA — Database (PostgreSQL)

## Two databases, never mixed

| Database (env var) | Default name | Contents | Created by |
|---|---|---|---|
| Live (`LIVE_DB_NAME`) | `miata_live_db` | The actual application data. Starts empty except the default completion policy. | `npm run db:setup`, then `npm run create-admin` |
| Mock (`MOCK_DB_NAME`) | `miata_mock_db` | Development and testing data loaded from [`database/mock-data`](../database/mock-data) | `npm run db:mock` (`-- --reset` to reload) |

The server picks one with `DATA_SOURCE=live|mock` (or `npm run dev:mock` / `start:mock`). The test suite always uses the mock
database: each test file rebuilds its schema, and `npm test` reloads the mock data when the run ends. Uploaded files are kept
apart the same way (`UPLOAD_DIR`, `MOCK_UPLOAD_DIR`). Safeguards: the two names must differ (the server refuses to start
otherwise), the mock loader refuses to write to `LIVE_DB_NAME`, the test reset refuses any database other than
`MOCK_DB_NAME`, and `DATA_SOURCE=mock` is refused when `NODE_ENV=production`.

## Migrations

The schema is created by versioned SQL files in [`database/migrations`](../database/migrations), applied in order by
`npm run migrate` (or `npm run db:setup`, which also creates the database). Each applied file is recorded in
`schema_migrations`, and the API refuses to start while migrations are pending. Never edit an applied migration; add the next
numbered file.

| Migration | Contents |
|---|---|
| `001_functions.sql` | `set_updated_at()` trigger function |
| `002_tables.sql` | Code sequences (`STU1001…`, `PRF1001…`) and every table with its columns, primary key, `NOT NULL` and defaults |
| `003_relationships.sql` | All foreign keys, named `fk_<table>_<column>`, with their `CASCADE` / `RESTRICT` / `SET NULL` rules |
| `004_constraints.sql` | Unique (`uq_*`) and check (`ck_*`) constraints: allowed values, formats, cross-column rules |
| `005_indexes.sql` | Lookup indexes, the case-insensitive unique e-mail index and the partial unique index on open submissions |
| `006_triggers.sql` | `updated_at` triggers |
| `007_views.sql` | `enrolment_progress` and `student_status` views |
| `008_reference_data.sql` | The default `completion_policy` setting (the only row every database needs) |
| `009_submission_status_transitions.sql` | Trigger that only allows the submission lifecycle `submitted → in_review → completed / rework` (see below) |
| `010_batches.sql` | Batches: `batches`, `batch_courses`, `batch_students`, `batch_professors`, material availability (`module_batches`, `video_batches`), `assignments.batch_id` + `assignment_students`, the audience functions, and `enrolment_progress` recreated to count only material that applies to each student |
| `012_online_meetings.sql` | Online classes: `meetings`, `meeting_participants`, the `email_deliveries` log, and the `setup` purpose for account set-up links |
| `013_fees_access_applications.sql` | Course access periods (`course_enrolments.start_date` / `end_date`, `student_access` view, `users.deactivated_reason`, `student_profiles.access_expired_on`), fees (`courses.fee_amount`, `course_enrolments.fee_amount` / `discount_amount`), `fee_payments` with the `enrolment_fees` view and the `fee_settings` setting, and agent applications (`agent_referrals` source `agent`, `applied_course_id`, `notes`). The `enrolment_defaults` trigger fills in a new enrolment's dates and fee |
| `015_course_timetable.sql` | Course timetables inside the course structure: `courses.academic_year` / `start_date` / `end_date` / `schedule_notes` and `lessons.week_number` (plus lecturer columns on modules, moved by 016). Drops the separate `timetables`, `timetable_streams` and `timetable_sessions` tables of the withdrawn `014_timetables.sql` (development databases only, never used by the application; the migration stops if any still holds rows) and removes that file's `schema_migrations` record |
| `016_course_lecturers.sql` | `course_lecturers` (a course's lecturer allocations: name, optional professor account, allocation, day, times, session length) and `lessons.course_lecturer_id` (the lecturer of a weekly session). The lecturer columns 015 put on modules move here — one course lecturer per distinct name and course, scheduled lessons linked — and are dropped |
| `017_module_status.sql` | `module_statuses`: how far the teaching of each module has got (`not_started` / `in_progress` / `completed`, with start and completion times), set by the professors who teach it |

These files replace the earlier two-file schema (`001_initial_schema.sql`, `002_student_status_view.sql`). The resulting
schema was compared object by object with the old one (columns, types, defaults, constraints, indexes, triggers, views) and
is identical.

## Mock data

[`database/mock-data/tables/*.json`](../database/mock-data/tables) holds one JSON file per table (rows exactly as exported,
including ids and timestamps) and [`database/mock-data/uploads`](../database/mock-data/uploads) the matching files (videos,
assignment attachments, submissions, payment proofs). `npm run db:mock` creates the mock database, runs the migrations, inserts the rows in
foreign-key order in one transaction, moves the id and code sequences past the loaded rows, and copies the files to
`MOCK_UPLOAD_DIR`. Refresh tokens, reset tokens and migration records are never part of mock data.

Every mock account uses the password `Miata-6C75DR9` (mock data only). The mock data holds exactly the accounts the
application needs, all active: the admin `admin@miata.local`; agents `ramesh.agent@` and `priya.agent@`; the 2026–2027
timetable's lecturers as the five professors — `niveditha@`, `jai@`, `saranya@`, `suzmitha@`, `bagyavasan@` (sample
addresses: the documents give none); and five students — `arun.kumar@`, `priya.sharma@`, `sneha.reddy@`, `meera.iyer@`,
`divya.pillai@` (all `@miata.local`). The demo professors and students of the original dataset were removed on 26 Oct 2026,
with the records that existed only because of them (their assignments, submissions, reviews, online classes and e-mails,
enrolments, payments, activity entries and files), as were the sample enquiries; every course, module, lesson, video and batch
was kept.

Fees and payments in the mock data (currency AUD, with sample transfer instructions): the PG Diploma costs $36,000, Clinical
Training $8,000 and ARDMS Preparation $2,500. Arun has a $10,000 scholarship, one approved and one pending payment; Priya
Sharma has an approved and a rejected payment; Meera has an approved payment; Divya has a pending payment; Sneha has paid
nothing yet. Every payment has a proof image in `uploads/payment-proofs`. Ramesh referred Arun and Priya Sharma; Priya Nair
referred Sneha.

Courses: PG Diploma in Ultrasound (`PGDU`), Clinical Training (`CLIN`), ARDMS Preparation (`ARDMS`), Paid Internship
(`PINT`) and Continuing Education in Sonography (`CEU`) from the original dataset, with their modules, lessons and three
videos, and the course below.

**MIATA Postgraduate Sonography** (course 6, code `PGS-2627` — a sample code: the source documents give none) holds the
2026–2027 curriculum and revised weekly timetable, created by the real import (`POST /admin/timetable-templates/pg-sonography-2026-27/import`):
academic year 2026–2027, 19 Oct 2026 – 18 Apr 2027 (26 weeks); the 14 curriculum modules with their 212 topics plus the
revised timetable's Peripheral Nerve Sonography, Nerve Blocks and Neurosonography module; five course lecturers —
Dr. Niveditha (Sunday), Jai, Dr. Saranya and Dr. Suzmitha (mutually agreed days), Dr. Bagyavasan (weekday), one-hour
sessions, times not set, each linked to their professor account and assigned as professor of the modules they teach
(17 module assignments, no others on the course) — and their 96 weekly sessions, each in its module. The cardiac module is
in the catalogue but not scheduled. No student is enrolled in it yet.

Module statuses in the mock data: on the PG Diploma, Ultrasound Physics & Instrumentation and Abdominal Ultrasound are
Completed and Obstetrics & Gynecology In Progress; on Clinical Training, Scanning Protocols is Completed and Supervised
Clinical Practice In Progress (marked by professors no longer in the data, so "updated by" is empty); on MIATA Postgraduate
Sonography, the five modules with week-1 sessions are In Progress, each marked by its lecturer on 23 Oct 2026. Every other
module is Not Started.

Batches in the mock data: **PGDU Batch 2026-A** (PG Diploma; students Arun, Priya Sharma, Sneha), **PGDU Batch 2026-B**
(PG Diploma; Divya) and **Clinical Training 2026** (Meera); the "Abdominal Scanning Fundamentals" video is restricted to
2026-A. The original courses and the batches have no professors assigned yet, and so no assignments, submissions or online
classes.

### How the existing data was migrated

The data that existed before the restructure (the demo dataset) became the mock data: its rows were exported to
`database/mock-data/tables` and its upload folder to `database/mock-data/uploads`, the mock database was built from those
files, and `npm run db:compare` confirmed every table identical to the original (same row counts, same row checksums, no
duplicates). The original database and its backup have since been removed; `database/mock-data` is the only source of the
mock data.

## Checking data consistency

```bash
npm run db:compare -- <databaseA> <databaseB>
```

Compares every table of two databases: row count, an MD5 checksum over all rows (as JSON, independent of column order) and
duplicate rows. Comparing a database with itself reports duplicate rows only. Exit code 1 when anything differs.

## Schema

All primary keys are `BIGINT GENERATED ALWAYS AS IDENTITY`. All timestamps are `TIMESTAMPTZ`. Tables with an `updated_at` column
keep it current through the `set_updated_at()` trigger.

## Entity relationships

```
users ─┬─ 1:1 ─ student_profiles      (student_code STU1001…)
       ├─ 1:1 ─ professor_profiles    (employee_code PRF1001…)
       ├─ 1:1 ─ agent_profiles        (referral_code, UNIQUE)
       ├─ 1:N ─ refresh_tokens, password_reset_tokens, notifications
       └─ 1:N ─ activity_logs (actor)

agent_referrals:  agent (users) 1:N ── referral ── 1:1 student (users)   [UNIQUE student_id]; applied_course_id? → courses

courses ─ 1:N ─ modules ─ 1:N ─ lessons
courses ─ N:M ─ students     via course_enrolments            [UNIQUE (course_id, student_id)]
courses ─ N:M ─ professors   via professor_course_assignments [UNIQUE (professor_id, course_id)]
modules ─ N:M ─ professors   via professor_module_assignments [UNIQUE (professor_id, module_id)]
modules ─ 1:1 ─ module_statuses (teaching status; no row = not started)

batches ─ N:M ─ courses      via batch_courses                [UNIQUE (batch_id, course_id)]
batches ─ 1:N ─ students     via batch_students               [UNIQUE student_id: one batch per student]
batches ─ N:M ─ professors   via batch_professors             [UNIQUE (batch_id, professor_id)]
modules / videos ─ N:M ─ batches via module_batches / video_batches  (no rows = available to every batch)

course_enrolments ─ 1:N ─ fee_payments (proof_file_id → files)   [RESTRICT: an enrolment with payments cannot be deleted]

files (metadata of stored bytes) ◄─ videos.file_id, assignments.attachment_file_id, assignment_submissions.file_id,
                                    fee_payments.proof_file_id

videos (course, module?, lesson?) ─ 1:N ─ video_progress (per student) [UNIQUE (video_id, student_id)]
assignments (course, module?, batch?) ─ 1:N ─ assignment_submissions (attempts) ─┬─ 1:N ─ assignment_reviews
                                                                                └─ 1:N ─ submission_comments
assignments ─ N:M ─ students (selected students of a batch assignment) via assignment_students
enquiries ─ 1:N ─ enquiry_notes
app_settings (key → JSONB)
```

## Tables

### Identity & access
| Table | Key columns | Notes |
|---|---|---|
| `users` | `email` (unique, enforced lowercase), `password_hash` (bcrypt), `full_name`, `phone`, `role` (`admin`/`agent`/`professor`/`student`), `is_active`, `deactivated_reason` (`admin`/`course_expired`, null while active), `must_reset_password`, `password_reset_reason` (`account_created`/`course_completed`/`admin_request`), `token_version`, `last_login_at` | One role per account. Incrementing `token_version` invalidates every access token issued before. |
| `student_profiles` | `user_id` PK/FK, `student_code` (sequence default `STU1001`…), `date_of_birth`, `address`, `city`, `country`, `qualification`, `access_expired_on` | `access_expired_on`: the course end date already dealt with (see *Course access periods*). |
| `professor_profiles` | `user_id`, `employee_code` (`PRF1001`…), `department`, `specialization`, `qualification`, `bio` | |
| `agent_profiles` | `user_id`, `referral_code` (UNIQUE, `^[A-Z0-9]{6,16}$`), `organization`, `city`, `country` | Codes are random (`AGT` + 5 characters), so they cannot be guessed in sequence. |
| `refresh_tokens` | `user_id`, `token_hash` (SHA-256, unique), `persistent`, `expires_at`, `revoked_at`, `replaced_by` | Rotated on every refresh. Reuse of a revoked token revokes the user's whole token family. |
| `password_reset_tokens` | `user_id`, `token_hash` (unique), `purpose` (`reset`/`forced`/`setup`), `expires_at` (30 min; `setup` 72 h), `used_at` | Single use. Creating a token invalidates older unused ones. `setup` links are e-mailed to admin-created accounts so they choose their own password (passwords are never e-mailed). |

### Referrals
| Table | Key columns | Notes |
|---|---|---|
| `agent_referrals` | `agent_id` → users, `student_id` → users **UNIQUE**, `referral_code` (snapshot at attribution), `source` (`link`/`admin`/`agent`), `created_by`, `applied_course_id?` → courses, `notes` | The unique `student_id` makes duplicate attribution impossible. `CHECK (agent_id <> student_id)`. Changes are admin-only and written to `activity_logs`. `agent` = registered by the agent with Apply Now; `applied_course_id` and `notes` record the application (enrolment stays with admins). |

### Courses & content
| Table | Key columns | Notes |
|---|---|---|
| `courses` | `code` (unique), `title`, `description`, `category`, `duration_value` + `duration_unit` (both or neither), `fee_amount` (≥ 0, optional), `is_active`, `academic_year` (`2026–2027`), `start_date`, `end_date` (not before the start), `schedule_notes` | Courses are deactivated, never deleted (enrolments reference them with `RESTRICT`). Week 1 of the timetable begins on `start_date`; week dates are derived, never stored. |
| `modules` | `course_id` (CASCADE), `title`, `description`, `position` | Ordered by `position, id`. A curriculum module. |
| `lessons` | `module_id` (CASCADE), `title`, `content`, `duration_minutes`, `position`, `week_number` (1–104), `course_lecturer_id` → course_lecturers (SET NULL) | A curriculum topic, or — with a `week_number` and a lecturer — a weekly session (within the course's dates; the lecturer one of the course's, checked by the service). Sessions are matched by module + week + lecturer: a session may share a topic's title. |
| `course_lecturers` | `course_id` (CASCADE), `lecturer_name` (unique per course, case-insensitive), `professor_id?` → users (SET NULL), `allocation`, `delivery_day` (`monday`…`sunday`/`weekday`/`agreed`), `start_time`, `end_time` (after the start), `session_minutes` (15–480), `position` | Who teaches the course's weekly sessions and when. Times stay NULL until confirmed. Linking a professor account makes them the professor of the modules they teach sessions in (`professor_module_assignments`, added by the service, never removed); course-wide permissions stay with `professor_course_assignments`. |
| `course_enrolments` | `course_id`, `student_id`, `status` (`active`/`suspended`/`completed`), `enrolled_at`, `completed_at`, `enrolled_by`, `start_date`, `end_date?`, `fee_amount`, `discount_amount` | `CHECK ((status = 'completed') = (completed_at IS NOT NULL))`. Only the completion service sets `completed`. The `enrolment_defaults` trigger (013) sets a new enrolment's `start_date` (the batch's start date when the course is taken with a batch that has one, else the enrolment day), `end_date` (start + course duration − 1 day; null = no end) and `fee_amount` (the course fee). `CHECK (end_date >= start_date)`, `CHECK (0 ≤ discount_amount ≤ fee_amount)`. Admins can change both per student. |
| `professor_course_assignments` | `professor_id`, `course_id`, `assigned_by` | The professor creates and reviews assignments anywhere in the course. |
| `professor_module_assignments` | `professor_id`, `module_id`, `assigned_by` | The professor creates and reviews that module's assignments only. On a course with lecturers, only professors linked to its lecturers (checked by the service). |
| `module_statuses` | `module_id` (CASCADE, **UNIQUE**), `status` (`not_started`/`in_progress`/`completed`), `started_at`, `completed_at`, `updated_by` → users (SET NULL), `updated_at` | How far the teaching of a module has got (017). No row = not started. Set by the module's professors or its course's professors (checked by the service), logged as `module.<status>`. `CHECK`: not started has neither time; in progress has `started_at` only; completed has both, completion not before the start. Going back to in progress keeps the first start. One status per module, shared by every batch taking the course. |

### Batches
| Table | Key columns | Notes |
|---|---|---|
| `batches` | `code` (unique, `^[A-Z0-9-]{2,30}$`), `name`, `description`, `start_date`, `end_date` (not before the start), `is_active`, `created_by` | A cohort. Inactive batches keep their students and history but take no new students, courses or batch assignments. Deleted only when empty. |
| `batch_courses` | `batch_id`, `course_id`, `added_by` | The courses the batch takes. Adding one enrols the batch's students. |
| `batch_students` | `batch_id`, `student_id` (**UNIQUE**), `added_by`, `added_at` | One batch per student; moving a student updates the row. Joining enrols the student in the batch's active courses. |
| `batch_professors` | `batch_id`, `professor_id`, `assigned_by` | Batch professors teach every course of the batch, to its students only. |
| `module_batches` · `video_batches` | `module_id` / `video_id`, `batch_id` (RESTRICT) | Availability. No rows = every student of the course (the behaviour without batches); rows = only students of those batches. A restricted module takes its lessons, videos and assignments with it. |
| `assignment_students` | `assignment_id`, `student_id` | Selected students of a batch assignment (no rows = the whole batch). |

### Files, videos, assignments
| Table | Key columns | Notes |
|---|---|---|
| `files` | `storage_key` (unique path under `UPLOAD_DIR`), `original_name`, `mime_type` (canonical, not client-supplied), `size_bytes`, `kind` (`video`/`attachment`/`submission`/`payment_proof`), `uploaded_by` | Bytes live on disk; only metadata is stored here. |
| `videos` | `course_id`, `module_id?`, `lesson_id?`, `file_id`, `title`, `duration_seconds` (> 0), `position`, `is_published`, `is_required`, `published_at` | Module and lesson must belong to the course (checked in the service). |
| `video_progress` | `video_id`, `student_id`, `watched_seconds`, `last_position`, `last_heartbeat_at`, `completed_at` | Watch time is credited from heartbeats, capped by real elapsed time. |
| `assignments` | `course_id`, `module_id?`, `batch_id?` (RESTRICT), `title`, `instructions`, `due_at`, `is_required`, `is_published`, `attachment_file_id?`, `created_by` | Created by a professor teaching the course/module, or for one of their batches (admins only read them). `batch_id` null = course-wide: publishing assigns it to every enrolled student. Set = that batch only (or its students listed in `assignment_students`). Deleting is refused once submissions exist (`RESTRICT`). |
| `assignment_submissions` | `assignment_id`, `student_id`, `attempt_no`, `file_id`, `notes`, `status` (`submitted`/`in_review`/`rework`/`completed`), `submitted_at`, `reviewed_at`, `reviewed_by` | `UNIQUE (assignment_id, student_id, attempt_no)`. A **partial unique index** allows at most one non-`rework` attempt per student and assignment, so a new attempt is only possible after rework. A **trigger** (009) allows only `submitted → in_review`, `submitted / in_review → completed / rework`; `completed` and `rework` are final for that attempt. |
| `assignment_reviews` | `submission_id`, `professor_id`, `decision` (`completed`/`rework`), `feedback` | `CHECK`: rework requires feedback. |
| `submission_comments` | `submission_id`, `author_id`, `body` (1–5000 characters) | Thread between professor and student. |

### Enquiries, notifications, audit, settings
| Table | Key columns | Notes |
|---|---|---|
| `enquiries` | `name`, `email`, `phone`, `subject`, `message`, `course_interest`, `source` (`website`/`admin`), `status` (`new`/`contacted`/`follow_up`/`converted`/`closed`), `follow_up_on`, `email_status` (`pending`/`sent`/`failed`/`skipped`), `email_error`, `ip_address` | The real email outcome is stored, never assumed. |
| `enquiry_notes` | `enquiry_id`, `author_id`, `note` | Follow-up timeline. Status changes add a note automatically. |
| `notifications` | `user_id`, `type`, `title`, `body`, `link`, `read_at` | In-app notifications (bell). |
| `activity_logs` | `actor_id`, `action` (e.g. `course.completed`), `entity_type`, `entity_id`, `description`, `metadata` JSONB, `ip_address` | Audit trail for every mutation and security event. |
| `email_deliveries` | `dedupe_key` (UNIQUE), `kind` (`account_created`/`account_setup`/`meeting_scheduled`/`meeting_updated`/`meeting_cancelled`), `user_id`, `meeting_id?`, `recipient`, `subject`, `status` (`pending`/`sent`/`failed`/`skipped`), `error`, `attempts`, `sent_at` | One row per e-mail to one person, written in the transaction that causes it and sent after commit; the real outcome is stored. The unique `dedupe_key` (e.g. `meeting:12:r2:meeting_updated:user:7`) makes a duplicate notification impossible. Failed / skipped rows can be retried (`claimForRetry`). |
| `app_settings` | `key` PK, `value` JSONB, `updated_by` | `completion_policy`: `requireAllVideos`, `requireAllAssignments`, `videoWatchThreshold`, `logoutOnCompletion`, `passwordResetOnCompletion`. `fee_settings`: `currency` (ISO code, default `AUD`), `paymentInstructions` (shown to students). |

### Online classes
| Table | Key columns | Notes |
|---|---|---|
| `meetings` | `batch_id` → batches (RESTRICT), `professor_id` (organiser), `title`, `description`, `platform` (`google_meet`/`zoom`, derived from the link), `meeting_url` (`https://`), `starts_at`, `duration_minutes` (15–480), `audience` (`batch`/`selected`), `status` (`scheduled`/`cancelled`), `cancel_reason`, `cancelled_at`, `revision` | Scheduled by one of the batch's professors. `revision` increases with every change students are told about and is part of each e-mail's dedupe key. Cancelled, never deleted. |
| `meeting_participants` | PK (`meeting_id`, `student_id`) | The students of a `selected` meeting (always students of its batch). |

Who a meeting is for is never stored per student: `studentMeetingPredicate` (`src/repositories/scope.js`) — active student
account, in the meeting's batch (batch active) and, for `selected`, listed in `meeting_participants`. The same rule decides
visibility and e-mail recipients, so a student who leaves the batch stops seeing (and being e-mailed about) its classes.

### Fees and payments
| Table | Key columns | Notes |
|---|---|---|
| `fee_payments` | `enrolment_id` → course_enrolments (RESTRICT), `amount` (> 0), `paid_on`, `method` (`bank_transfer`/`upi`/`card`/`cash`/`cheque`/`other`), `reference`, `notes`, `proof_file_id` → files (UNIQUE, RESTRICT), `status` (`pending`/`approved`/`rejected`), `review_note`, `reviewed_by`, `reviewed_at`, `submitted_by` | A payment a student reports with a screenshot or receipt. Only `approved` payments count as paid. `CHECK ((status = 'pending') = (reviewed_at IS NULL))`; a rejection requires a `review_note` (the student sees it). Admins may set a decision back to `pending`; every change is logged with the previous status. |

## Course access periods (migration 013)

Each enrolment runs from `start_date` to `end_date`. The `student_access` view gives the day a student's access ends: the
latest `end_date` of their enrolments, or `NULL` when they are not enrolled or any enrolment has no end. The API
(`src/services/accessExpiry.service.js`) checks at start-up, every `ACCESS_EXPIRY_CHECK_MINUTES` (default 60) and at each
student sign-in: a student whose access ended before today (in `APP_TIMEZONE`) is deactivated
(`deactivated_reason = 'course_expired'`), signed out everywhere, logged as `student.access_expired`, and the admins are
notified.

Each end date deactivates an account once (`student_profiles.access_expired_on`): an admin who reactivates the account is
not overruled until a later end date passes. Changing an enrolment's dates applies the new dates at once: an account that
was deactivated only because access ended is reactivated when the new period runs on, and an active one is deactivated
when the new end date has already passed.

## Views (derived data, never stored)

- **`enrolment_progress`**: per enrolment, the counts `videos_total / videos_done` (published, required videos with `completed_at`)
  and `assignments_total / assignments_done` (published, required assignments with a `completed` submission), counting only
  the material that applies to that student (see the audience functions below), so another batch's videos or assignments
  never block a completion. The completion policy decides which counts matter. See `src/services/progress.service.js`.
- **`student_status`**: per student, `status` = `inactive` (account off) › `active` (has an active enrolment) ›
  `completed` (no active enrolment, at least one completed) › `pending`. Also `course_titles`, `enrolment_count`,
  `completed_count`. Agent referral counts and all referral reports are computed from this view.
- **`enrolment_fees`** (013): per enrolment, `fee_amount`, `discount_amount`, `payable` (fee − discount), `paid` (approved
  payments), `pending` (payments awaiting verification) and `balance` (payable − paid; negative = overpaid).
- **`student_access`** (013): per enrolled student, `access_ends_on` (see *Course access periods*).

## Audience functions (migration 010)

One definition of "what belongs to whom", used by the `enrolment_progress` view and by every API query through
`src/repositories/scope.js`, so the admin, professor and student views always agree:

| Function | Returns |
|---|---|
| `enrolment_batch_id(student, course)` | The student's batch when that batch takes the course, else `NULL` (an unbatched enrolment, handled by the course's own professors) |
| `module_available_to(module, student)` | `TRUE` for course-level content, unrestricted modules, or modules restricted to the student's batch |
| `video_available_to(video, module, student)` | The module is available and the video is unrestricted or restricted to the student's batch |
| `assignment_assigned_to(assignment, batch, module, student)` | The module is available and the work is course-wide, or for the student's batch (and, with selected students, the student is one of them) |

A batched enrolment is visible only to the batch's professors; course and module professors keep every unbatched one.

## Transactions

Operations that must succeed or fail together run in one transaction (`withTransaction`). Examples:
- account creation with role profile, referral and enrolments, set-up token and the queued welcome e-mail
- an online class change with its participants, revision, in-app notifications and queued e-mails (sent after commit)
- submission with file record and notifications
- payment proof with file record, payment row and admin notifications (the enrolment row is locked, so parallel uploads
  cannot report more than is open)
- payment decision with status change, log entry and student notification
- review decision with status change, review row, notification and log entry
- course completion with enrolment status, log entry, notifications, forced reset and session revocation
- password reset with password update, token consumption and session revocation

File bytes are removed only after the database transaction commits.

## Inspecting with pgAdmin 4

Connect to `localhost:5432` as the configured `DB_USER` and open **miata_live_db** (or `miata_mock_db`) **→ Schemas → public**. Useful queries:

```sql
-- Referral counts per agent (same numbers the agent dashboard shows)
SELECT ag.full_name, count(r.id) AS total,
       count(*) FILTER (WHERE ss.status = 'active') AS active,
       count(*) FILTER (WHERE ss.status = 'completed') AS completed
  FROM users ag LEFT JOIN agent_referrals r ON r.agent_id = ag.id
  LEFT JOIN student_status ss ON ss.student_id = r.student_id
 WHERE ag.role = 'agent' GROUP BY ag.id;

-- Progress of every enrolment
SELECT u.full_name, c.title, e.status, ep.* FROM course_enrolments e
  JOIN users u ON u.id = e.student_id JOIN courses c ON c.id = e.course_id
  JOIN enrolment_progress ep ON ep.enrolment_id = e.id;

-- Recent security-relevant activity
SELECT created_at, action, description FROM activity_logs
 WHERE action LIKE 'auth.%' OR action = 'course.completed' ORDER BY created_at DESC LIMIT 50;
```
