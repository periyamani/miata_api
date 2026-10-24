# MIATA — REST API

Base URL: `/api` on the miata-api server (default `http://localhost:5000/api`). In development, miata-web's Vite server proxies
`/api` to it, so the browser sees one origin. When miata-web is hosted on another origin, add that origin to `FRONTEND_URL` /
`CORS_ORIGINS` (credentials are allowed for those origins only).
All 160 routes are listed below, grouped by area. Request and response bodies are JSON (`camelCase`), except file uploads (`multipart/form-data`) and downloads.

## Conventions

| Topic | Rule |
|---|---|
| Authentication | `Authorization: Bearer <accessToken>` (15-minute JWT). The refresh token is an httpOnly cookie `miata_rt` scoped to `/api/auth`. |
| Cookie endpoints | `POST /auth/refresh` and `POST /auth/logout` require the header `X-Requested-With: XMLHttpRequest` (CSRF defence). |
| Success | `{ "data": … }`, with `"meta"` on lists. |
| Lists | Query `page` (default 1), `pageSize` (default 10, max 100), `search`, `sort`, `order` (`asc`/`desc`) plus endpoint filters. The response carries `meta: { page, pageSize, total, totalPages }`. |
| Errors | `{ "error": { "code", "message", "details?" } }`. `details` maps field → message for validation errors. |
| Status codes | `200` OK · `201` created · `400` bad request · `401` not authenticated (`TOKEN_EXPIRED`, `SESSION_REVOKED`, `PASSWORD_RESET_REQUIRED`, `ACCOUNT_DISABLED`, `INVALID_CREDENTIALS` …) · `403` wrong role (`FORBIDDEN`) or wrong login portal (`ROLE_MISMATCH`) · `404` not found *or outside your scope* · `409` conflict · `413` file too large · `415` file type not allowed · `422` validation · `429` rate limited · `500` generic error (details are only logged on the server). |
| Scoping | Agents, professors and students only ever see their own scope. Out-of-scope records return **404**, so their existence is not revealed. |

Rate limits (per IP): login 10 failed / 15 min · forgot-password 5 / 15 min · reset-password 20 / 15 min · register 10 / hour · public enquiries 5 / 10 min · whole API 1000 / 15 min.

---

## Public & authentication — `/api/auth`, `/api/enquiries`, `/api/health`

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /health` | — | `{ status: "ok", database }` |
| `POST /auth/login` | `{ email, password, remember?, role? }` | Returns `{ accessToken, user }` and sets the refresh cookie. `role` (`admin`/`agent`/`professor`/`student`) is the portal chosen on the login page: when the password is correct but the account has another role, the response is `403 ROLE_MISMATCH` with `details.role` (the account's real role) and no session. A wrong password always returns `401 INVALID_CREDENTIALS`, whatever the role. **If the account owes a password reset** (first login of an admin-created account, course completion, admin request), it returns `{ passwordResetRequired: true, resetToken, reason, email }` and no session. A student whose course access period has ended is deactivated at this point (if the periodic check has not done it yet) and gets `403 ACCOUNT_DISABLED` with a message saying their access ended. |
| `POST /auth/register` | `{ fullName, email, phone?, password, referralCode?, acceptTerms: true }` | Student self-registration. A valid `referralCode` attributes the student to that agent. Starts a session (201). |
| `GET /auth/referral/:code` | — | `{ valid, agentName?, organization? }`, used by the registration page. |
| `POST /auth/refresh` | cookie | Rotates the refresh token and returns `{ accessToken, user }`. With no cookie it returns `data: null` (not signed in). Reuse of a revoked token revokes every session of the user. |
| `POST /auth/logout` | cookie | Revokes the refresh token and clears the cookie. |
| `POST /auth/forgot-password` | `{ email }` | Always the same response. Emails a single-use 30-minute link when the account exists. |
| `POST /auth/reset-password/verify` | `{ token }` | `{ valid, email, purpose, reason }`, or `400 INVALID_RESET_TOKEN`. |
| `POST /auth/reset-password` | `{ token, password }` | Sets the new password (must differ from the old one), clears the reset flag and ends all sessions. |
| `GET /auth/me` | — | Current user with role profile. |
| `GET /auth/session` | — | Lightweight heartbeat (the dashboards poll it every 60 s). |
| `POST /enquiries` | `{ name, email, phone?, subject?, message, courseInterest? }` | Website contact form. Stores the enquiry, notifies admins in-app, then attempts the notification email. (201) |

## Any signed-in user — `/api/profile`, `/api/notifications`, `/api/media`

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /profile` | — | Own user and role profile (agents also get `referralLink`). |
| `PATCH /profile` | `fullName?, phone?` and role fields | Student: `dateOfBirth, address, city, country, qualification`. Professor: `specialization, qualification, bio`. Agent: `organization, city, country`. Email and codes are admin-managed. |
| `POST /profile/password` | `{ currentPassword, newPassword }` | Ends all other sessions and returns a fresh session for this device. |
| `GET /notifications` | `limit?`, `unreadOnly?` | `meta.unread` gives the badge count. |
| `PATCH /notifications/:id/read` | — | Own notifications only. |
| `POST /notifications/read-all` | — | |
| `GET /media/videos/:videoId/stream?token=` | — | Video streaming with HTTP Range support. The `token` is a 2-hour signed token bound to user + video (from the video detail endpoints). Access is re-checked on every request. |

## Admin — `/api/admin` (role `admin`)

**Dashboard, search & lookups**

| Method & path | Notes |
|---|---|
| `GET /admin/dashboard?months=6` | `stats` (students, professors, agents, courses, batches, pending assignments, new enquiries, `pendingPayments`), `monthly` (enrolments, registrations, enquiries, completions), `completion` (completed / in progress / not started), `courses`, `batches` (active batches with average progress and reviews waiting), `recentEnquiries`, `recentActivity` |
| `GET /admin/search?q=` | Top 5 students, professors, agents, courses and batches |
| `GET /admin/lookups/courses` | id / title / code / isActive for selects |
| `GET /admin/lookups/courses/:courseId/curriculum` | Modules with their lessons |
| `GET /admin/lookups/batches` | id / name / code / isActive / `courseIds` for selects |
| `GET /admin/lookups/{students\|professors\|agents}?search=&limit=` | People pickers |

**Courses, modules, lessons**

| Method & path | Body / query |
|---|---|
| `GET /admin/courses` | `search, status (active\|inactive), sort (title\|code\|created_at\|students)` |
| `POST /admin/courses` · `PUT /admin/courses/:courseId` | `{ code, title, description?, category?, durationValue?, durationUnit? (days\|weeks\|months\|years), feeAmount? (≥ 0, 2 decimals), isActive, academicYear? (e.g. 2026–2027), startDate?, endDate? (YYYY-MM-DD, not before the start; week 1 begins on the start date), scheduleNotes? }`. The fee is copied to each new enrolment; existing enrolments keep theirs. Dates ending before a scheduled topic's week are refused (`422`). |
| `GET /admin/courses/:courseId` | Course, counts, ordered modules with lessons (each with `weekNumber`, `courseLecturerId` and `lecturerName` for a scheduled session), module professors, the batches each module is restricted to (`batches`, empty = every batch) and each module's teaching status as its professors set it (`teachingStatus`, `teachingStartedAt`, `teachingCompletedAt`, `teachingUpdatedAt`, `teachingUpdatedBy` — see `PUT /professor/modules/:moduleId/status`), course professors, `batches` taking the course, and `lecturers` (as below) |
| `PATCH /admin/courses/:courseId/status` | `{ isActive }` |
| `GET /admin/courses/:courseId/students` | Enrolled students with progress. `search, status (active\|suspended\|completed)` |
| `POST /admin/courses/:courseId/modules` · `PUT /admin/modules/:moduleId` | `{ title, description? }` |
| `DELETE /admin/modules/:moduleId` | Deletes its lessons. Videos and assignments stay on the course. |
| `PUT /admin/courses/:courseId/modules/order` | `{ ids: [moduleId…] }` (every module exactly once) |
| `POST /admin/modules/:moduleId/lessons` · `PUT /admin/lessons/:lessonId` | `{ title, content?, durationMinutes?, weekNumber?, courseLecturerId? }` — a curriculum topic, or a weekly session: the programme week (within the course's dates when it has both) and the course lecturer teaching it (one of the course's lecturers; needs a week). `422` otherwise. |
| `DELETE /admin/lessons/:lessonId` | |
| `PUT /admin/modules/:moduleId/lessons/order` | `{ ids: [lessonId…] }` |
| `GET /admin/timetable-templates` | Built-in course timetables: `key, name, courseTitle, academicYear, startDate, endDate, durationValue, durationUnit, moduleCount, topicCount, sessionCount, lecturers[], excludedModules[], missing[]` (what the source documents do not state) |
| `GET /admin/courses/:courseId/timetable` | `week?, moduleId?, lecturerId?` — the weekly timetable from the course structure: `course` (dates, academic year, notes), `today`, `weekCount`, `currentWeek`, `status` (upcoming\|running\|finished\|undated), `lecturers[]`, `modules[]` (`moduleNumber, topicCount, sessionCount, firstWeek, lastWeek`) and `weeks[] { number, startsOn, endsOn, sessions[] { id, title, weekNumber, durationMinutes, moduleId, moduleTitle, moduleNumber, courseLecturerId, lecturerName } }`. A module or lecturer outside the course: `422`. |
| `POST /admin/courses/:courseId/lecturers` · `PUT /admin/course-lecturers/:lecturerId` · `DELETE …` | Course lecturers: `{ lecturerName, professorId? (an active professor), allocation?, deliveryDay? (monday…sunday\|weekday\|agreed), startTime?, endTime? (HH:MM, end after start), sessionMinutes? (15–480) }`. Names are unique per course, compared without case (`409`). Returned with `professorName`, `courseAllocated` (the linked professor is assigned to the course), `firstWeek`, `lastWeek`, `sessionCount`. Linking a professor makes them the professor of every module where the lecturer teaches sessions (assignments are only added; giving a lesson a linked lecturer does the same). Deleting keeps the sessions, without a lecturer, and the module assignments. |
| `POST /admin/timetable-templates/:key/import` | `{ courseId }` imports into an existing course; `{ code, category? }` creates a new course with the template's heading. `dryRun: true` performs the import in a transaction that is rolled back (a preview). `moduleMap: { templateModuleKey: existingModuleId \| null }` matches curriculum modules to existing modules with other names. Matching: modules by exact title (case, `&`/`and`, punctuation ignored) or `moduleMap` — similar titles come back as `suggestions`, never merged on their own; lecturers by name (titles such as "Dr." ignored), linked to a professor account only when exactly one has that name; sessions by module + week + lecturer; topics by title within the module. Only empty fields are filled in. Returns `{ summary, course }` (`course` is null for a dry run): `summary { dryRun, course { action, fieldsFilled }, modules[] { key, title, action: created\|reused\|mapped, moduleId, existingTitle?, suggestions? }, lecturers[] { name, action: created\|reused\|updated, professor { status: linked\|already_linked\|ambiguous\|unmatched }, courseAllocated }, topics { created, unchanged }, sessions { created, updated, unchanged, keptDifferent[] }, moduleProfessors { assigned[] { module, professor } (linked lecturers made professors of the modules they teach), notLecturers[] { module, professor } (module professors who are not the course's lecturers: reported, never removed) }, review[] (sessions placed in a module by judgement), excludedModules[], missing[] }`. `409` for a taken code; `422` for a mapping outside the course or used twice, or course dates shorter than the timetable. |

**Enrolments & teaching assignments**

| Method & path | Body |
|---|---|
| `POST /admin/courses/:courseId/enrolments` | `{ studentIds: [] }` (course must be active; existing enrolments are skipped) |
| `POST /admin/students/:studentId/enrolments` | `{ courseIds: [] }` |
| `PATCH /admin/enrolments/:enrolmentId` | `{ status: active\|suspended }`. Completed enrolments cannot be changed. |
| `PUT /admin/enrolments/:enrolmentId/schedule` | `{ startDate, endDate? }` (YYYY-MM-DD; `endDate: null` = no end). The student's access period for the course; a new enrolment gets the batch's start date (when taken with a batch that has one) or the enrolment day, and ends after the course duration. The account is checked at once: returns `{ accountReactivated, accountDeactivated }` — reactivated when it had been deactivated only because access ended and the new period runs on, deactivated when the new end date has passed. Logged. |
| `PUT /admin/enrolments/:enrolmentId/fee` | `{ feeAmount, discountAmount? }` (discount ≤ fee). What the student is charged for the course; payments already made are kept. Returns the `enrolment_fees` row (`payable, paid, pending, balance`). The student is notified; logged with the previous values. |
| `DELETE /admin/enrolments/:enrolmentId` | Not allowed for completed enrolments, or when fee payments are recorded for it (`409`: suspend it instead) |
| `POST /admin/courses/:courseId/professors` · `DELETE …/professors/:professorId` | `{ professorId }`: the professor creates and reviews assignments anywhere in the course |
| `POST /admin/modules/:moduleId/professors` · `DELETE …/professors/:professorId` | `{ professorId }`: the professor creates and reviews that module's assignments. On a course with lecturers, only a professor linked to one of them (`422` otherwise). |

**Batches** (cohorts: courses, professors and students; see *Batch-wise access* below)

| Method & path | Body / query |
|---|---|
| `GET /admin/batches` | `search, status (active\|inactive), courseId, professorId, sort (name\|code\|start_date\|created_at\|students)`, with courses, professors, counts, `pendingReviews` and `progress { enrolments, completed, averagePercent }` |
| `POST /admin/batches` | `{ code, name, description?, startDate?, endDate? (YYYY-MM-DD, not before start), isActive, courseIds?, professorIds? }`. Codes are upper-cased (`409` when taken). Courses must be active. |
| `GET /admin/batches/:batchId` | Batch, counts, progress, `courses` (enrolled / completed students of the batch) and `professors` |
| `PUT /admin/batches/:batchId` · `PATCH /admin/batches/:batchId/status` | Batch fields · `{ isActive }`. An inactive batch keeps its students and history but takes no new students, courses or batch assignments (`422`). |
| `DELETE /admin/batches/:batchId` | Only an empty batch: `409` while it has students, assignments or restricted material (deactivate it instead) |
| `GET /admin/batches/:batchId/students` | Students with per-course `courses[].progress`, `averagePercent` and assignment tracking (`assignmentsTotal, assignmentsSubmitted, assignmentsPendingReview, assignmentsRework, assignmentsCompleted, assignmentsOverdue`). `search, sort (full_name\|added_at\|student_code)` |
| `POST /admin/batches/:batchId/students` | `{ studentIds: [] }`: adds them, moving students from their current batch (one batch per student), and enrols them in the batch's active courses. Returns `{ added, moved, alreadyInBatch, enrolled }`. |
| `DELETE /admin/batches/:batchId/students/:studentId` | Leaves the batch; enrolments, submissions and progress are kept |
| `POST /admin/batches/:batchId/courses` · `DELETE …/courses/:courseId` | `{ courseId }`: the batch takes the course and its students are enrolled. Removing keeps the enrolments. |
| `POST /admin/batches/:batchId/professors` · `DELETE …/professors/:professorId` | `{ professorId }`: the professor teaches every course of the batch, to its students only |
| `GET /admin/batches/:batchId/materials` | Per batch course: `modules` and `videos` with `batches` (restricted to; empty = every batch) and `available` (for this batch) |
| `PUT /admin/modules/:moduleId/batches` · `PUT /admin/videos/:videoId/batches` | `{ batchIds: [] }`: restrict a module (with its lessons, videos and assignments) or a video to these batches; `[]` makes it available to every student of the course. Each batch must take the course (`422`). |

**People** (`students`, `professors`, `agents` share the same pattern)

| Method & path | Body / query |
|---|---|
| `GET /admin/students` | `search, status (active\|pending\|completed\|inactive), courseId, agentId, batchId (an id, or none), referred, sort (full_name\|created_at\|student_code\|status\|batch)`, with the student's batch |
| `GET /admin/professors` | `search, status (active\|inactive), courseId, sort (full_name\|created_at\|pending_reviews)` |
| `GET /admin/agents` | `search, status, sort (full_name\|created_at\|referrals)`, with referral counts by status |
| `POST /admin/{students\|professors\|agents}` | `{ fullName, email, phone?, temporaryPassword?, …profile fields }`. Students also accept `courseIds?, agentId?, batchId?` (joins the batch and its courses), professors `courseIds?`. The account must choose its own password before it can sign in: a welcome e-mail with the account details and a single-use set-password link (72 h) is sent, and the response says what happened to it: `welcomeEmail { status: sent\|failed\|skipped, error, recipient }`. `temporaryPassword` is optional (to hand over in person; never e-mailed) — required (`422`) when SMTP is not configured. |
| `POST /admin/{role}s/:userId/setup-email` | E-mails a new single-use set-password link (earlier links stop working). Returns `{ status, error, recipient }`. `409` for deactivated accounts. |
| `GET /admin/students/:userId` | Profile (with `deactivatedReason`: `admin` \| `course_expired`), derived status, `access { accessEndsOn, accessExpiredOn }`, referral (with `appliedCourseTitle` and `notes` for agent applications), `batch` (with its courses and professors), enrolments with progress, the batch each is taken with, `startDate / endDate` and fees (`feeAmount, discountAmount, payable, paid, pending, balance`), `fees` totals with the `currency`, `payments`, the assignments set for the student (as the student sees them), recent activity |
| `GET /admin/professors/:userId` | Profile, workload, courses, modules, batches, recent reviews |
| `GET /admin/agents/:userId` | Profile, referral code + link, counts, 12-month trend, referrals by course |
| `PUT /admin/{role}s/:userId` | Identity and profile fields |
| `PATCH /admin/{role}s/:userId/status` | `{ isActive }`. Deactivation ends sessions immediately. Reactivating a student whose access has ended keeps them active until a later course end date passes. |
| `POST /admin/{role}s/:userId/temporary-password` | `{ temporaryPassword }`: forced change at next login |
| `PUT /admin/students/:userId/referral` | `{ agentId \| null }`: attribute, reassign or remove (logged with the previous agent) |
| `PUT /admin/students/:userId/batch` | `{ batchId \| null }`: add to a batch (moving from the current one, enrolling in its courses) or take out of it (logged) |
| `GET /admin/agents/:userId/referrals` | Paginated referred students |
| `POST /admin/agents/:userId/referral-code` | Generates a new code (old links stop working) |

**Referrals**

| Method & path | Notes |
|---|---|
| `GET /admin/referrals` | All referred students. `agentId, status, courseId, search, sort` |
| `GET /admin/referrals/report` | Totals, per-agent summary, 12-month trend, by course |
| `GET /admin/referrals/export` | CSV (formula-injection safe). Same filters. |

**Fee payments** (proofs students upload; only approved payments count as paid)

| Method & path | Body / query |
|---|---|
| `GET /admin/payments` | `status (pending\|approved\|rejected), courseId, studentId, search (student, ID, e-mail, reference), sort (created_at\|paid_on\|amount\|student\|status)`. Each with `amount, paidOn, method, reference, notes, status, reviewNote, reviewedAt, reviewedByName`, the course, the student and the proof file name / type. `meta.currency` is the fee currency. |
| `GET /admin/payments/stats` | `pendingCount, pendingAmount, approvedCount, approvedAmount, approvedThisMonth, rejectedCount, outstanding` (sum of positive balances), `currency` |
| `GET /admin/payments/:paymentId` | The payment and `fees` (the enrolment's `feeAmount, discountAmount, payable, paid, pending, balance`) |
| `GET /admin/payments/:paymentId/proof` | The screenshot or receipt (inline) |
| `PATCH /admin/payments/:paymentId/status` | `{ status: pending\|approved\|rejected, note? }`. Approving counts it as paid and lowers the balance; rejecting requires `note` (shown to the student, `422` without it); `pending` undoes a decision. The student is notified; logged with the previous status. Returns the payment as `GET`. |

**Assignments & submissions** (read-only: professors create, assign and review them — see the Professor section)

| Method & path | Body / query |
|---|---|
| `GET /admin/assignments` | `courseId, moduleId, batchId, published, search, sort (title\|due_at\|created_at)`, with submission counts over the students each assignment is assigned to, `createdByName` and the audience (`batchId, batchName, recipientCount, recipients`). With `batchId`: the batch's work (its own and course-wide work in its courses), counted for that batch's students. |
| `GET /admin/assignments/:assignmentId` | |
| `GET /admin/assignments/:assignmentId/attachment` | Download |
| `POST /admin/assignments` · `PUT` · `DELETE /admin/assignments/:assignmentId` | Always `403 FORBIDDEN`: admins cannot create, edit, publish or delete assignments |
| `GET /admin/submissions` | `status (pending\|submitted\|in_review\|rework\|completed), courseId, assignmentId, studentId, professorId (submissions that professor may review), batchId (students of the batch), latestOnly, search, sort`, with the student's batch |
| `GET /admin/submissions/:submissionId` | Submission + all attempts, reviews and comments |
| `GET /admin/submissions/:submissionId/file` | Download |

**Videos**

| Method & path | Body / query |
|---|---|
| `GET /admin/videos` | `courseId, moduleId, batchId (available to that batch), published, search, sort`, with `batches` (restricted to; empty = every batch) |
| `POST /admin/videos` | multipart: file `video` (mp4, m4v, webm, ogv; ≤ `MAX_VIDEO_SIZE_MB`) + `courseId, moduleId?, lessonId?, title, description?, durationSeconds, position?, isRequired, isPublished, batchIds?` (comma-separated; empty = every batch). MP4 durations are read from the file itself. `PUT` also accepts `batchIds` (omitted = unchanged). |
| `GET /admin/videos/:videoId` · `PUT /admin/videos/:videoId` | Metadata. A course cannot change once students have watch progress. |
| `PATCH /admin/videos/:videoId/publish` | `{ isPublished }`. Publishing notifies enrolled students. |
| `DELETE /admin/videos/:videoId` | Deletes the file too |
| `GET /admin/videos/:videoId/access` | `{ url, expiresAt }`, a signed stream URL for preview |

**Enquiries, settings, activity**

| Method & path | Body / query |
|---|---|
| `GET /admin/enquiries` | `status (new\|contacted\|follow_up\|converted\|closed), source (website\|admin), from, to (YYYY-MM-DD), search, sort` |
| `GET /admin/enquiries/counts` | Count per status |
| `POST /admin/enquiries` | Manual entry (same fields as the public form; no notification email) |
| `GET /admin/enquiries/:enquiryId` | With the notes timeline |
| `PATCH /admin/enquiries/:enquiryId` | `{ status?, followUpOn? }`. A status change adds a timeline note. |
| `POST /admin/enquiries/:enquiryId/notes` | `{ note }` |
| `POST /admin/enquiries/:enquiryId/notify` | Retry the notification email |
| `GET /admin/settings` | `completionPolicy`, `fees { currency, paymentInstructions }`, email configuration status |
| `PUT /admin/settings/fees` | `{ currency (3 letters, e.g. AUD), paymentInstructions? (≤ 2000) }`: the currency of every fee and payment, and the transfer details students see |
| `PUT /admin/settings/completion-policy` | `{ requireAllVideos, requireAllAssignments, videoWatchThreshold (50–100), logoutOnCompletion, passwordResetOnCompletion (next_login\|email_link\|none) }`. At least one requirement must be on. |
| `GET /admin/activity` | Audit log. `search, action (prefix, e.g. course.), actorId, entityType, entityId` |

**Online classes** (read-only monitoring: professors schedule them — see the Professor section)

| Method & path | Query / notes |
|---|---|
| `GET /admin/meetings` | `when (upcoming\|past\|cancelled), batchId, professorId, search, sort (starts_at\|title\|created_at)`. Each with `batchName, professorName, endsAt, recipientCount, emails { sent, pending, failed, skipped }` |
| `GET /admin/meetings/:meetingId` | Meeting, `participantIds`, `recipients[]` (student, e-mail address, latest e-mail `emailKind / emailStatus / emailError / emailSentAt`) |

## Agent — `/api/agent` (role `agent`, own referrals only)

| Method & path | Notes |
|---|---|
| `GET /agent/dashboard?months=6` | `counts { total, active, pending, completed, inactive, thisMonth }`, `monthly` (new + cumulative), `recentStudents`, `referralCode`, `referralLink` |
| `GET /agent/students` | `search, status, courseId, sort`. Name, student ID, courses, registration date, status, `source` and the course applied for only (no contact details). Any `agentId` in the query is ignored. |
| `GET /agent/students/:studentId` | 404 unless the student is this agent's referral. Includes per-course progress. |
| `GET /agent/students/export` | CSV of own referrals |
| `GET /agent/stats?months=12` | Counts, monthly series, referrals by course |
| `GET /agent/apply` | Apply Now options: active `courses` (title, code, duration, fee), `currency`, `emailConfigured` |
| `POST /agent/students` | **Apply Now**: `{ fullName, email, phone?, temporaryPassword?, dateOfBirth?, address?, city?, country?, qualification?, courseId?, notes? }`. Creates the student exactly like an admin-created account (welcome e-mail with a set-password link; `temporaryPassword` required when SMTP is not configured), attributes them to the signed-in agent (`source: agent`, any `agentId` is ignored), records the course applied for and the note, and notifies the admins. Enrolment stays with MIATA. Returns `{ id, fullName, studentCode, welcomeEmail }`. `409` when the e-mail is taken, `422` for an inactive course. |

## Professor — `/api/professor` (role `professor`, assigned courses/modules and batches only)

| Method & path | Body / query |
|---|---|
| `GET /professor/dashboard` | Stats, `batches`, recent students, recent assignments, upcoming deadlines, recent activity |
| `GET /professor/batches` | The professor's batches: courses, co-professors, student count, published batch work, reviews waiting, `progress { enrolments, completed, averagePercent }` |
| `GET /professor/courses` | Courses the professor sees: `wholeCourse`, their `modules`, their `batches` taking it, and `studentCount` (students they teach) |
| `GET /professor/courses/:courseId/modules?batchId=` | Modules the professor may put assignments in: for a batch, every module available to it; for course-wide work, all of them for a course professor, only their own for a module professor. `404` outside their courses or batches. |
| `GET /professor/modules` | Modules of active courses whose status the professor keeps up to date: every module of a course they teach as a whole, and the modules they are assigned to (batch professors have none). Ordered by course and position, each with `number` (its place in the course), `courseId`, `courseTitle`, `courseCode`, `lessonCount`, `weeks` (of its scheduled sessions), `professors` (module professors' names) and `teachingStatus` (`not_started` \| `in_progress` \| `completed`), `teachingStartedAt`, `teachingCompletedAt`, `teachingUpdatedAt`, `teachingUpdatedBy` (name) |
| `PUT /professor/modules/:moduleId/status` | `{ status: not_started \| in_progress \| completed }`. Returns the module as above. Going in progress or completed keeps the first start time; completing stamps the completion; not started clears both. Each change is logged (`module.<status>`); setting the current status changes nothing. `404` for a module outside the list above, `422` for any other status. |
| `GET /professor/timetable` | Weekly timetables (as `GET /admin/courses/:courseId/timetable`, unfiltered) of the active courses with sessions that the professor lectures in or teaches, each with `myLecturerIds` (the course lecturers linked to them). Lecturers carry no account details (`id, lecturerName, allocation, deliveryDay, startTime, endTime, sessionMinutes, position, firstWeek, lastWeek, sessionCount`). |
| `GET /professor/students` | `courseId, batchId, status, search, sort (full_name\|enrolled_at\|last_activity\|batch)`, with progress and the batch each enrolment is taken with. Batched students appear only for their batch's professors. |
| `GET /professor/assignments` · `GET /professor/assignments/:assignmentId` | Assignments they manage (drafts included) plus course-wide work in their batches' courses, which they review for their batch (`canManage: false`). Counts cover only the students they teach. `courseId, batchId, published, search, sort (title\|due_at\|created_at\|pending)` |
| `POST /professor/assignments` · `PUT /professor/assignments/:assignmentId` | multipart: `courseId, moduleId?, batchId?, studentIds? (comma-separated), title, instructions?, dueAt? (ISO), isRequired, isPublished, removeAttachment?` + optional file `attachment` (pdf, doc(x), ppt(x), xls(x), zip, txt, jpg, png; ≤ 20 MB). Without `batchId` the work is course-wide and the placement must be in the professor's course/module scope. With `batchId` it is for that batch (the professor must teach it, it must be active and take the course, the module must be available to it), narrowed to `studentIds` when given (students of the batch enrolled in the course) — `422` on the offending field otherwise. Publishing assigns it to, and notifies, the actively enrolled students it is for (and anyone added to it later). Course or batch cannot change once submissions exist (`409`); `403` on course-wide work the professor only reviews. |
| `DELETE /professor/assignments/:assignmentId` | `409` when submissions exist (unpublish instead) |
| `GET /professor/assignments/:assignmentId/attachment` | |
| `GET /professor/submissions` | `status, courseId, batchId, assignmentId, latestOnly, search, sort`: submissions the professor may review, with the student's batch |
| `GET /professor/submissions/:submissionId` | Attempts, reviews and comments |
| `GET /professor/submissions/:submissionId/file` | |
| `POST /professor/submissions/:submissionId/start-review` | `submitted → in_review` |
| `POST /professor/submissions/:submissionId/comments` | `{ body }` |
| `POST /professor/submissions/:submissionId/review` | `{ decision: completed\|rework, feedback? }` (feedback required for rework). Latest attempt only, once. Returns `{ submission, courseCompleted }`. A "completed" decision may complete the student's course. |
| `GET /professor/meetings` · `GET /professor/meetings/:meetingId` | Online classes the professor organised. `when (upcoming\|past\|cancelled), batchId, search, sort`. The detail lists `recipients[]` with their e-mail status (no addresses). |
| `POST /professor/meetings` · `PUT /professor/meetings/:meetingId` | `{ batchId, title, description?, meetingUrl, startsAt (ISO), durationMinutes (15–480, default 60), audience: batch\|selected, studentIds? }`. Only batches the professor is assigned to; `meetingUrl` must be an `https` Google Meet (`meet.google.com`) or Zoom (`*.zoom.us`) link; `startsAt` in the future (when it changes); `selected` students must belong to the batch. Returns the meeting with `notified { scheduled, updated, cancelled }` (students e-mailed) and, on `PUT`, `unchanged`. See *Online classes* below. `409` once cancelled. |
| `POST /professor/meetings/:meetingId/cancel` | `{ reason? }` — the audience is e-mailed (reason included, link withheld). `409` if already cancelled or over. |
| `POST /professor/meetings/:meetingId/resend` | Retries e-mails that failed or were skipped. Returns `{ retried, sent, failed, skipped, meeting }`. |
| `GET /professor/meetings/batches/:batchId/students` | The batch's active students (to choose "selected students"). `404` outside the professor's batches. |

## Student — `/api/student` (role `student`, own enrolments and own batch's material only)

| Method & path | Body / query |
|---|---|
| `GET /student/dashboard` | `batch` (name, code, dates, courses, professors; `null` when not in one), stats, featured videos, modules, assignments, activity, courses with progress (and their `startDate / endDate`), `fees { currency, payable, paid, pending, balance }`, `accessEndsOn` (last day of access; the account is deactivated after it) |
| `GET /student/courses` · `GET /student/courses/:courseId` | Course detail: ordered modules → lessons → videos (with watch state) → assignments (with status), plus progress |
| `GET /student/modules?courseId=` | Module status: completed / in_progress / not_started |
| `GET /student/timetable` | Weekly timetables of the student's active courses with sessions: only the sessions of modules available to them (batch restrictions apply); lecturers as for professors. `[]` when none. |
| `GET /student/videos` | `courseId, moduleId, status (watched\|unwatched)`. Published videos only. |
| `GET /student/videos/:videoId` | Video, own progress, signed `stream.url`, previous/next |
| `POST /student/videos/:videoId/progress` | `{ position }` heartbeat (every ~10 s while playing). Returns `watchedSeconds, videoCompleted, courseCompleted, sessionEnded, passwordResetRequired`. |
| `GET /student/assignments` | `courseId, status (pending\|submitted\|in_review\|rework\|completed)`. Work assigned to the student (course-wide, their batch's, or selected for them) plus anything they already submitted to; `batchName`, `forSelectedStudents`. Other batches' work is `404`. |
| `GET /student/assignments/:assignmentId` | Brief, attempts, reviews, comments, `canSubmit` + `reason` |
| `GET /student/assignments/:assignmentId/attachment` | |
| `POST /student/assignments/:assignmentId/submissions` | multipart: file `file` (document types, ≤ 20 MB) + `notes?`. Allowed for attempt 1, or after "rework". `409 SUBMISSION_NOT_ALLOWED` otherwise. |
| `GET /student/submissions` | Own history with latest feedback |
| `GET /student/submissions/:submissionId/file` | Own files only |
| `POST /student/submissions/:submissionId/comments` | `{ body }` |
| `GET /student/progress` | Per course, with module breakdown |
| `GET /student/completion` | Policy summary + courses with completion status and criteria |
| `GET /student/fees` | `currency`, `paymentInstructions`, `totals { payable, paid, pending, balance }`, `courses[]` (per enrolment: `feeAmount, discountAmount, payable, paid, pending, balance`) and `payments[]` (with `status`, `reviewNote`) |
| `POST /student/payments` | multipart: file `proof` (png, jpg, webp or pdf; ≤ `MAX_DOCUMENT_SIZE_MB`) + `courseId, amount (> 0), paidOn (YYYY-MM-DD, not in the future), method (bank_transfer\|upi\|card\|cash\|cheque\|other), reference?, notes?`. The amount may not exceed the balance less payments awaiting verification (`422`). Saved as `pending`; admins are notified. |
| `GET /student/payments/:paymentId/proof` | Own proofs only |
| `GET /student/meetings?when=upcoming\|past` | Online classes of the student's batch, or shared with them: `title, description, platform, meetingUrl, startsAt, endsAt, durationMinutes, status, cancelReason, batchName, professorName`. Upcoming includes cancelled classes (with `meetingUrl: null`). The dashboard also returns the next four as `upcomingMeetings`. |

## Assignment and submission lifecycle

| Who | May |
|---|---|
| Professor | Create, edit, publish/unpublish and delete (no submissions yet) assignments in their scope — course-wide, or for one of their batches (whole batch or selected students); open, comment on and review the latest attempt of the submissions they may review |
| Student | See published assignments set for them in courses they are enrolled in (course active). Submit attempt 1, or a new attempt after Rework, while the enrolment is active. Comment on and download their own submissions. Cannot edit or delete a submission. |
| Admin | Read everything (assignments, submissions, attempts, reviews, comments, files); change nothing |

| Status | Set by | Next |
|---|---|---|
| `pending` (no attempt; derived, not stored) | — | `submitted` when the student uploads |
| `submitted` | student upload (`POST /student/assignments/:id/submissions`) | `in_review` (professor opens it), or directly `completed` / `rework` |
| `in_review` | `POST /professor/submissions/:id/start-review` | `completed` / `rework` |
| `rework` | professor review, feedback required | final for this attempt; the student uploads attempt N+1 (`submitted`) |
| `completed` | professor review | final; submissions closed. May complete the course. |

The services answer disallowed actions with `409`; a database trigger (migration 009) rejects any other status change.

There is deliberately **no endpoint that marks a course complete**. Completion is evaluated only by the server, after a video crosses the watch threshold or a professor marks a submission Completed.

## Batch-wise access

A batch is a cohort: it takes one or more courses, has its own professors and its students (one batch per student).
Course access is still decided by enrolment; adding students or courses to a batch enrols the students. The same rules
apply to every query (`src/repositories/scope.js` and the SQL functions of migration 010):

| Rule | Detail |
|---|---|
| Who teaches whom | A student's enrolment in a course their batch takes belongs to the **batch's professors only**. Any other enrolment (no batch, or a course outside the batch) stays with the course and module professors, exactly as before batches. |
| Assignments | Course-wide (`batchId` null, every enrolled student), for one batch, or for selected students of one batch. Students see only work set for them (`404` otherwise); professors review the submissions of the students they teach. |
| Modules and videos | Available to every batch unless restricted to some batches; a restricted module takes its lessons, videos and assignments with it. Students not in a batch see unrestricted material only. |
| Progress and completion | Count only the videos and assignments that apply to the student, so another batch's material never blocks a completion. |
| Notifications | Publishing work notifies the students it is for; a submission or comment notifies the professors who may review it. |
