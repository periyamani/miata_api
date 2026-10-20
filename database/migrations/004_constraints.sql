-- 004 · Constraints: uniqueness and allowed values (business rules enforced by the database itself).

-- Users
ALTER TABLE users ADD CONSTRAINT ck_users_role CHECK (role IN ('admin', 'agent', 'professor', 'student'));
ALTER TABLE users ADD CONSTRAINT ck_users_email_lowercase CHECK (email = lower(email));
ALTER TABLE users ADD CONSTRAINT ck_users_reset_reason
  CHECK (password_reset_reason IN ('account_created', 'course_completed', 'admin_request'));

-- Role profiles
ALTER TABLE student_profiles   ADD CONSTRAINT uq_student_profiles_code   UNIQUE (student_code);
ALTER TABLE professor_profiles ADD CONSTRAINT uq_professor_profiles_code UNIQUE (employee_code);
ALTER TABLE agent_profiles     ADD CONSTRAINT uq_agent_profiles_referral_code UNIQUE (referral_code);
ALTER TABLE agent_profiles     ADD CONSTRAINT ck_agent_profiles_referral_code CHECK (referral_code ~ '^[A-Z0-9]{6,16}$');

-- Referrals: one attribution per student (prevents duplicate referral attribution)
ALTER TABLE agent_referrals ADD CONSTRAINT uq_agent_referrals_student UNIQUE (student_id);
ALTER TABLE agent_referrals ADD CONSTRAINT ck_agent_referrals_source CHECK (source IN ('link', 'admin'));
ALTER TABLE agent_referrals ADD CONSTRAINT ck_agent_referrals_not_self CHECK (agent_id <> student_id);

-- Tokens
ALTER TABLE refresh_tokens        ADD CONSTRAINT uq_refresh_tokens_hash UNIQUE (token_hash);
ALTER TABLE password_reset_tokens ADD CONSTRAINT uq_password_reset_tokens_hash UNIQUE (token_hash);
ALTER TABLE password_reset_tokens ADD CONSTRAINT ck_password_reset_tokens_purpose CHECK (purpose IN ('reset', 'forced'));

-- Courses & content
ALTER TABLE courses ADD CONSTRAINT uq_courses_code UNIQUE (code);
ALTER TABLE courses ADD CONSTRAINT ck_courses_duration_value CHECK (duration_value > 0);
ALTER TABLE courses ADD CONSTRAINT ck_courses_duration_unit CHECK (duration_unit IN ('days', 'weeks', 'months', 'years'));
ALTER TABLE courses ADD CONSTRAINT ck_courses_duration_pair CHECK ((duration_value IS NULL) = (duration_unit IS NULL));
ALTER TABLE lessons ADD CONSTRAINT ck_lessons_duration CHECK (duration_minutes > 0);

-- Enrolments: a student enrols in a course once; "completed" always carries its timestamp
ALTER TABLE course_enrolments ADD CONSTRAINT uq_course_enrolments UNIQUE (course_id, student_id);
ALTER TABLE course_enrolments ADD CONSTRAINT ck_course_enrolments_status CHECK (status IN ('active', 'suspended', 'completed'));
ALTER TABLE course_enrolments ADD CONSTRAINT ck_course_enrolments_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL));

-- Teaching assignments
ALTER TABLE professor_course_assignments ADD CONSTRAINT uq_professor_course UNIQUE (professor_id, course_id);
ALTER TABLE professor_module_assignments ADD CONSTRAINT uq_professor_module UNIQUE (professor_id, module_id);

-- Files and videos
ALTER TABLE files  ADD CONSTRAINT uq_files_storage_key UNIQUE (storage_key);
ALTER TABLE files  ADD CONSTRAINT ck_files_size CHECK (size_bytes >= 0);
ALTER TABLE files  ADD CONSTRAINT ck_files_kind CHECK (kind IN ('video', 'attachment', 'submission'));
ALTER TABLE videos ADD CONSTRAINT ck_videos_duration CHECK (duration_seconds > 0);
ALTER TABLE video_progress ADD CONSTRAINT uq_video_progress UNIQUE (video_id, student_id);
ALTER TABLE video_progress ADD CONSTRAINT ck_video_progress_watched CHECK (watched_seconds >= 0);

-- Submissions & reviews
ALTER TABLE assignment_submissions ADD CONSTRAINT uq_submission_attempt UNIQUE (assignment_id, student_id, attempt_no);
ALTER TABLE assignment_submissions ADD CONSTRAINT ck_submissions_attempt CHECK (attempt_no >= 1);
ALTER TABLE assignment_submissions ADD CONSTRAINT ck_submissions_status CHECK (status IN ('submitted', 'in_review', 'rework', 'completed'));
ALTER TABLE assignment_reviews ADD CONSTRAINT ck_reviews_decision CHECK (decision IN ('completed', 'rework'));
ALTER TABLE assignment_reviews ADD CONSTRAINT ck_reviews_rework_feedback CHECK (decision <> 'rework' OR length(trim(coalesce(feedback, ''))) > 0);
ALTER TABLE submission_comments ADD CONSTRAINT ck_comments_body CHECK (length(body) BETWEEN 1 AND 5000);

-- Enquiries
ALTER TABLE enquiries ADD CONSTRAINT ck_enquiries_source CHECK (source IN ('website', 'admin'));
ALTER TABLE enquiries ADD CONSTRAINT ck_enquiries_status CHECK (status IN ('new', 'contacted', 'follow_up', 'converted', 'closed'));
ALTER TABLE enquiries ADD CONSTRAINT ck_enquiries_email_status CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped'));
ALTER TABLE enquiry_notes ADD CONSTRAINT ck_enquiry_notes_note CHECK (length(note) BETWEEN 1 AND 5000);
