/**
 * Reusable SQL predicates that define who may see what. Keeping them in one place guarantees the
 * admin views, professor portal and authorisation checks agree. The batch audience rules themselves are
 * SQL functions (migration 010) shared with the enrolment_progress view.
 *
 * `param` is a placeholder from SqlBuilder.param(), never a raw value.
 */

/** Professor teaches a course: assigned to it directly, or to any of its modules (not through a batch). */
export const professorTeachesCoursePredicate = (courseIdExpr, param) => `(
  EXISTS (SELECT 1 FROM professor_course_assignments pca
           WHERE pca.course_id = ${courseIdExpr} AND pca.professor_id = ${param})
  OR EXISTS (SELECT 1 FROM professor_module_assignments pma JOIN modules pm ON pm.id = pma.module_id
              WHERE pm.course_id = ${courseIdExpr} AND pma.professor_id = ${param}))`;

/** Professor is assigned to a batch. */
export const professorBatchPredicate = (batchIdExpr, param) =>
  `EXISTS (SELECT 1 FROM batch_professors bp WHERE bp.batch_id = ${batchIdExpr} AND bp.professor_id = ${param})`;

/** Professor is assigned to a batch that takes the course. */
export const professorBatchCoursePredicate = (courseIdExpr, param) => `EXISTS (
  SELECT 1 FROM batch_professors bp JOIN batch_courses bc ON bc.batch_id = bp.batch_id
   WHERE bc.course_id = ${courseIdExpr} AND bp.professor_id = ${param})`;

/** Professor may see a course and its content: teaches it, or one of their batches takes it. */
export const professorCoursePredicate = (courseIdExpr, param) =>
  `(${professorTeachesCoursePredicate(courseIdExpr, param)} OR ${professorBatchCoursePredicate(courseIdExpr, param)})`;

/**
 * Professor may see a student's enrolment in a course. A batched enrolment (the student's batch takes the course)
 * belongs to that batch's professors only; any other enrolment to the course's own professors, as before batches.
 */
export const professorStudentPredicate = (studentIdExpr, courseIdExpr, param) => `(CASE
  WHEN enrolment_batch_id(${studentIdExpr}, ${courseIdExpr}) IS NULL THEN ${professorTeachesCoursePredicate(courseIdExpr, param)}
  ELSE ${professorBatchPredicate(`enrolment_batch_id(${studentIdExpr}, ${courseIdExpr})`, param)} END)`;

/**
 * Professor may create, edit and review course-wide assignments placed in a course/module: assigned to the whole
 * course, or to that specific module (module-level professors only manage their module, never course-wide work).
 */
export const professorPlacementPredicate = (courseIdExpr, moduleIdExpr, param) => `(
  EXISTS (SELECT 1 FROM professor_course_assignments pca
           WHERE pca.course_id = ${courseIdExpr} AND pca.professor_id = ${param})
  OR (${moduleIdExpr} IS NOT NULL AND EXISTS (
        SELECT 1 FROM professor_module_assignments pma
         WHERE pma.module_id = ${moduleIdExpr} AND pma.professor_id = ${param})))`;

/** Professor manages (edits, publishes, deletes) an assignment aliased `alias`: course-wide work by placement, batch work by batch. */
export const professorAssignmentPredicate = (alias, param) => `(CASE
  WHEN ${alias}.batch_id IS NULL THEN ${professorPlacementPredicate(`${alias}.course_id`, `${alias}.module_id`, param)}
  ELSE ${professorBatchPredicate(`${alias}.batch_id`, param)} END)`;

/**
 * Professor may open an assignment: manages it, or it is course-wide work in a course one of their batches takes
 * (they review that work for their batch's students).
 */
export const professorAssignmentVisiblePredicate = (alias, param) => `(${professorAssignmentPredicate(alias, param)}
  OR (${alias}.batch_id IS NULL AND ${professorBatchCoursePredicate(`${alias}.course_id`, param)}))`;

/** Professor may review a submission (aliases `s` and `a`): the batch's professors for a batched enrolment, else whoever manages the assignment. */
export const professorSubmissionPredicate = (sAlias, aAlias, param) => `(CASE
  WHEN enrolment_batch_id(${sAlias}.student_id, ${aAlias}.course_id) IS NULL THEN ${professorAssignmentPredicate(aAlias, param)}
  ELSE ${professorBatchPredicate(`enrolment_batch_id(${sAlias}.student_id, ${aAlias}.course_id)`, param)} END)`;

/**
 * Student is in the audience of a meeting aliased `alias`: belongs to its batch (which must be active) and, for a
 * meeting shared with selected students, is one of them. Used both for visibility and to pick e-mail recipients.
 */
export const studentMeetingPredicate = (alias, param) => `(
  EXISTS (SELECT 1 FROM batch_students mbs JOIN batches mb ON mb.id = mbs.batch_id
           WHERE mbs.batch_id = ${alias}.batch_id AND mbs.student_id = ${param} AND mb.is_active)
  AND (${alias}.audience = 'batch'
       OR EXISTS (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = ${alias}.id AND mp.student_id = ${param})))`;

/** Student may access a course's content: enrolled (active or completed) and the course is active. */
export const studentCoursePredicate = (courseIdExpr, param) => `EXISTS (
  SELECT 1 FROM course_enrolments se JOIN courses sc ON sc.id = se.course_id
   WHERE se.course_id = ${courseIdExpr} AND se.student_id = ${param}
     AND se.status IN ('active', 'completed') AND sc.is_active)`;

/** Module (and its lessons) available to the student: not restricted to other batches. */
export const studentModulePredicate = (moduleIdExpr, param) => `module_available_to(${moduleIdExpr}, ${param})`;

/** Video aliased `alias` available to the student: neither it nor its module is restricted to other batches. */
export const studentVideoPredicate = (alias, param) => `video_available_to(${alias}.id, ${alias}.module_id, ${param})`;

/** Assignment aliased `alias` is assigned to the student (course-wide, or for their batch / them). */
export const assignmentAudiencePredicate = (alias, studentIdExpr) =>
  `assignment_assigned_to(${alias}.id, ${alias}.batch_id, ${alias}.module_id, ${studentIdExpr})`;

/** Student may see an assignment: it is assigned to them, or they already submitted to it (history survives a batch change). */
export const studentAssignmentPredicate = (alias, param) => `(${assignmentAudiencePredicate(alias, param)}
  OR EXISTS (SELECT 1 FROM assignment_submissions own WHERE own.assignment_id = ${alias}.id AND own.student_id = ${param}))`;

/** Student belongs to a batch. */
export const studentInBatchPredicate = (studentIdExpr, batchIdExpr) =>
  `EXISTS (SELECT 1 FROM batch_students sib WHERE sib.student_id = ${studentIdExpr} AND sib.batch_id = ${batchIdExpr})`;
