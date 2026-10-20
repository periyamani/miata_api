import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import * as ctrl from './assignments.controller.js';
import * as s from './assignments.schemas.js';

// Read-only oversight. Creating, editing, publishing and reviewing happen in /api/professor.
const router = Router();

router.get('/assignments', validate({ query: s.listAssignmentsQuery }), ctrl.list);
router.get('/assignments/:assignmentId', validate({ params: s.assignmentIdParams }), ctrl.get);
router.get('/assignments/:assignmentId/attachment', validate({ params: s.assignmentIdParams }), ctrl.attachment);
router.post('/assignments', ctrl.professorsOnly);
router.put('/assignments/:assignmentId', ctrl.professorsOnly);
router.delete('/assignments/:assignmentId', ctrl.professorsOnly);

router.get('/submissions', validate({ query: s.listSubmissionsQuery }), ctrl.listSubmissions);
router.get('/submissions/:submissionId', validate({ params: s.submissionIdParams }), ctrl.getSubmission);
router.get('/submissions/:submissionId/file', validate({ params: s.submissionIdParams }), ctrl.submissionFile);

export default router;
