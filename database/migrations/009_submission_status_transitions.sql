-- 009 · Submission status transitions, enforced on every UPDATE of assignment_submissions.status.
--
--   (new attempt)            → submitted     student uploads attempt 1, or attempt N+1 after rework (INSERT)
--   submitted                → in_review     a professor opens the submission
--   submitted | in_review    → completed     professor's decision (latest attempt, once)
--   submitted | in_review    → rework        professor's decision; feedback required (ck_reviews_rework_feedback)
--   completed, rework                         final for that attempt. After rework the student uploads a NEW attempt.
--
-- The services return friendly 409s first; this trigger guarantees no code path (or manual SQL) can, for example,
-- reopen a completed attempt or move a reviewed attempt back to in_review.

CREATE FUNCTION check_submission_status_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status
     OR (OLD.status = 'submitted' AND NEW.status IN ('in_review', 'completed', 'rework'))
     OR (OLD.status = 'in_review' AND NEW.status IN ('completed', 'rework')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Submission status cannot change from % to %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assignment_submissions_status_transition
  BEFORE UPDATE OF status ON assignment_submissions
  FOR EACH ROW EXECUTE FUNCTION check_submission_status_transition();
