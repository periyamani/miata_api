-- 003 · Relationships (foreign keys).
-- ON DELETE rules: CASCADE for data owned by a parent (profiles, tokens, modules → lessons),
-- RESTRICT for history that must survive (enrolments, submissions, reviews), SET NULL for "who did it" columns.

-- Role profiles: one per user
ALTER TABLE student_profiles   ADD CONSTRAINT fk_student_profiles_user   FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE professor_profiles ADD CONSTRAINT fk_professor_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE agent_profiles     ADD CONSTRAINT fk_agent_profiles_user     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

-- Referrals: agent 1:N students
ALTER TABLE agent_referrals ADD CONSTRAINT fk_agent_referrals_agent      FOREIGN KEY (agent_id)   REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE agent_referrals ADD CONSTRAINT fk_agent_referrals_student    FOREIGN KEY (student_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE agent_referrals ADD CONSTRAINT fk_agent_referrals_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL;

-- Tokens
ALTER TABLE refresh_tokens        ADD CONSTRAINT fk_refresh_tokens_user        FOREIGN KEY (user_id)     REFERENCES users (id)          ON DELETE CASCADE;
ALTER TABLE refresh_tokens        ADD CONSTRAINT fk_refresh_tokens_replaced_by FOREIGN KEY (replaced_by) REFERENCES refresh_tokens (id) ON DELETE SET NULL;
ALTER TABLE password_reset_tokens ADD CONSTRAINT fk_password_reset_tokens_user FOREIGN KEY (user_id)     REFERENCES users (id)          ON DELETE CASCADE;

-- Courses → modules → lessons
ALTER TABLE courses ADD CONSTRAINT fk_courses_created_by FOREIGN KEY (created_by) REFERENCES users (id)   ON DELETE SET NULL;
ALTER TABLE modules ADD CONSTRAINT fk_modules_course     FOREIGN KEY (course_id)  REFERENCES courses (id) ON DELETE CASCADE;
ALTER TABLE lessons ADD CONSTRAINT fk_lessons_module     FOREIGN KEY (module_id)  REFERENCES modules (id) ON DELETE CASCADE;

-- Enrolments: courses N:M students
ALTER TABLE course_enrolments ADD CONSTRAINT fk_course_enrolments_course      FOREIGN KEY (course_id)   REFERENCES courses (id) ON DELETE RESTRICT;
ALTER TABLE course_enrolments ADD CONSTRAINT fk_course_enrolments_student     FOREIGN KEY (student_id)  REFERENCES users (id)   ON DELETE RESTRICT;
ALTER TABLE course_enrolments ADD CONSTRAINT fk_course_enrolments_enrolled_by FOREIGN KEY (enrolled_by) REFERENCES users (id)   ON DELETE SET NULL;

-- Teaching: courses/modules N:M professors
ALTER TABLE professor_course_assignments ADD CONSTRAINT fk_pca_professor   FOREIGN KEY (professor_id) REFERENCES users (id)   ON DELETE CASCADE;
ALTER TABLE professor_course_assignments ADD CONSTRAINT fk_pca_course      FOREIGN KEY (course_id)    REFERENCES courses (id) ON DELETE CASCADE;
ALTER TABLE professor_course_assignments ADD CONSTRAINT fk_pca_assigned_by FOREIGN KEY (assigned_by)  REFERENCES users (id)   ON DELETE SET NULL;
ALTER TABLE professor_module_assignments ADD CONSTRAINT fk_pma_professor   FOREIGN KEY (professor_id) REFERENCES users (id)   ON DELETE CASCADE;
ALTER TABLE professor_module_assignments ADD CONSTRAINT fk_pma_module      FOREIGN KEY (module_id)    REFERENCES modules (id) ON DELETE CASCADE;
ALTER TABLE professor_module_assignments ADD CONSTRAINT fk_pma_assigned_by FOREIGN KEY (assigned_by)  REFERENCES users (id)   ON DELETE SET NULL;

-- Files and videos
ALTER TABLE files  ADD CONSTRAINT fk_files_uploaded_by  FOREIGN KEY (uploaded_by) REFERENCES users (id)   ON DELETE SET NULL;
ALTER TABLE videos ADD CONSTRAINT fk_videos_course      FOREIGN KEY (course_id)   REFERENCES courses (id) ON DELETE RESTRICT;
ALTER TABLE videos ADD CONSTRAINT fk_videos_module      FOREIGN KEY (module_id)   REFERENCES modules (id) ON DELETE SET NULL;
ALTER TABLE videos ADD CONSTRAINT fk_videos_lesson      FOREIGN KEY (lesson_id)   REFERENCES lessons (id) ON DELETE SET NULL;
ALTER TABLE videos ADD CONSTRAINT fk_videos_file        FOREIGN KEY (file_id)     REFERENCES files (id)   ON DELETE RESTRICT;
ALTER TABLE videos ADD CONSTRAINT fk_videos_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users (id)   ON DELETE SET NULL;
ALTER TABLE video_progress ADD CONSTRAINT fk_video_progress_video   FOREIGN KEY (video_id)   REFERENCES videos (id) ON DELETE CASCADE;
ALTER TABLE video_progress ADD CONSTRAINT fk_video_progress_student FOREIGN KEY (student_id) REFERENCES users (id)  ON DELETE CASCADE;

-- Assignments → submissions → reviews / comments
ALTER TABLE assignments ADD CONSTRAINT fk_assignments_course     FOREIGN KEY (course_id)          REFERENCES courses (id) ON DELETE RESTRICT;
ALTER TABLE assignments ADD CONSTRAINT fk_assignments_module     FOREIGN KEY (module_id)          REFERENCES modules (id) ON DELETE SET NULL;
ALTER TABLE assignments ADD CONSTRAINT fk_assignments_attachment FOREIGN KEY (attachment_file_id) REFERENCES files (id)   ON DELETE SET NULL;
ALTER TABLE assignments ADD CONSTRAINT fk_assignments_created_by FOREIGN KEY (created_by)         REFERENCES users (id)   ON DELETE SET NULL;
ALTER TABLE assignment_submissions ADD CONSTRAINT fk_submissions_assignment  FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE RESTRICT;
ALTER TABLE assignment_submissions ADD CONSTRAINT fk_submissions_student     FOREIGN KEY (student_id)    REFERENCES users (id)       ON DELETE RESTRICT;
ALTER TABLE assignment_submissions ADD CONSTRAINT fk_submissions_file        FOREIGN KEY (file_id)       REFERENCES files (id)       ON DELETE RESTRICT;
ALTER TABLE assignment_submissions ADD CONSTRAINT fk_submissions_reviewed_by FOREIGN KEY (reviewed_by)   REFERENCES users (id)       ON DELETE SET NULL;
ALTER TABLE assignment_reviews  ADD CONSTRAINT fk_reviews_submission  FOREIGN KEY (submission_id) REFERENCES assignment_submissions (id) ON DELETE CASCADE;
ALTER TABLE assignment_reviews  ADD CONSTRAINT fk_reviews_professor   FOREIGN KEY (professor_id)  REFERENCES users (id)                  ON DELETE RESTRICT;
ALTER TABLE submission_comments ADD CONSTRAINT fk_comments_submission FOREIGN KEY (submission_id) REFERENCES assignment_submissions (id) ON DELETE CASCADE;
ALTER TABLE submission_comments ADD CONSTRAINT fk_comments_author     FOREIGN KEY (author_id)     REFERENCES users (id)                  ON DELETE RESTRICT;

-- Enquiries
ALTER TABLE enquiries     ADD CONSTRAINT fk_enquiries_created_by FOREIGN KEY (created_by) REFERENCES users (id)     ON DELETE SET NULL;
ALTER TABLE enquiry_notes ADD CONSTRAINT fk_enquiry_notes_enquiry FOREIGN KEY (enquiry_id) REFERENCES enquiries (id) ON DELETE CASCADE;
ALTER TABLE enquiry_notes ADD CONSTRAINT fk_enquiry_notes_author  FOREIGN KEY (author_id)  REFERENCES users (id)     ON DELETE SET NULL;

-- Notifications, activity, settings
ALTER TABLE notifications ADD CONSTRAINT fk_notifications_user      FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE activity_logs ADD CONSTRAINT fk_activity_logs_actor     FOREIGN KEY (actor_id)   REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE app_settings  ADD CONSTRAINT fk_app_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL;
