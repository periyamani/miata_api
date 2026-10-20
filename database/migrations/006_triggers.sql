-- 006 · Triggers: keep updated_at current on every UPDATE.

CREATE TRIGGER users_updated_at                  BEFORE UPDATE ON users                  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER student_profiles_updated_at       BEFORE UPDATE ON student_profiles       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER professor_profiles_updated_at     BEFORE UPDATE ON professor_profiles     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agent_profiles_updated_at         BEFORE UPDATE ON agent_profiles         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agent_referrals_updated_at        BEFORE UPDATE ON agent_referrals        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER courses_updated_at                BEFORE UPDATE ON courses                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER modules_updated_at                BEFORE UPDATE ON modules                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER lessons_updated_at                BEFORE UPDATE ON lessons                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER course_enrolments_updated_at      BEFORE UPDATE ON course_enrolments      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER videos_updated_at                 BEFORE UPDATE ON videos                 FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER video_progress_updated_at         BEFORE UPDATE ON video_progress         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assignments_updated_at            BEFORE UPDATE ON assignments            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assignment_submissions_updated_at BEFORE UPDATE ON assignment_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER enquiries_updated_at              BEFORE UPDATE ON enquiries              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
