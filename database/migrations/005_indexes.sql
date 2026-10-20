-- 005 · Indexes for the queries the API runs (lists, filters, scope checks) and partial unique indexes.

CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_role_idx ON users (role, is_active);

CREATE INDEX agent_referrals_agent_idx ON agent_referrals (agent_id, created_at DESC);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id) WHERE used_at IS NULL;

CREATE INDEX modules_course_idx ON modules (course_id, position);
CREATE INDEX lessons_module_idx ON lessons (module_id, position);
CREATE INDEX course_enrolments_student_idx ON course_enrolments (student_id);
CREATE INDEX professor_course_assignments_course_idx ON professor_course_assignments (course_id);
CREATE INDEX professor_module_assignments_module_idx ON professor_module_assignments (module_id);

CREATE INDEX videos_course_idx ON videos (course_id, is_published);
CREATE INDEX videos_module_idx ON videos (module_id);
CREATE INDEX video_progress_student_idx ON video_progress (student_id);

CREATE INDEX assignments_course_idx ON assignments (course_id, is_published);
CREATE INDEX assignments_due_idx ON assignments (due_at);
-- At most one attempt that is not "rework" per student and assignment: a new attempt is only possible after rework.
CREATE UNIQUE INDEX assignment_submissions_one_open ON assignment_submissions (assignment_id, student_id) WHERE status <> 'rework';
CREATE INDEX assignment_submissions_student_idx ON assignment_submissions (student_id);
CREATE INDEX assignment_submissions_status_idx ON assignment_submissions (status, submitted_at DESC);
CREATE INDEX assignment_reviews_submission_idx ON assignment_reviews (submission_id);
CREATE INDEX submission_comments_submission_idx ON submission_comments (submission_id, created_at);

CREATE INDEX enquiries_status_idx ON enquiries (status, created_at DESC);
CREATE INDEX enquiry_notes_enquiry_idx ON enquiry_notes (enquiry_id, created_at);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX activity_logs_created_idx ON activity_logs (created_at DESC);
CREATE INDEX activity_logs_actor_idx ON activity_logs (actor_id, created_at DESC);
CREATE INDEX activity_logs_entity_idx ON activity_logs (entity_type, entity_id);
