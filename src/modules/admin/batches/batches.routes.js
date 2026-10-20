import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import * as ctrl from './batches.controller.js';
import * as s from './batches.schemas.js';

const router = Router();

router.get('/batches', validate({ query: s.listBatchesQuery }), ctrl.list);
router.post('/batches', validate({ body: s.createBatchSchema }), ctrl.create);
router.get('/batches/:batchId', validate({ params: s.batchIdParams }), ctrl.get);
router.put('/batches/:batchId', validate({ params: s.batchIdParams, body: s.updateBatchSchema }), ctrl.update);
router.patch('/batches/:batchId/status', validate({ params: s.batchIdParams, body: s.statusSchema }), ctrl.setStatus);
router.delete('/batches/:batchId', validate({ params: s.batchIdParams }), ctrl.remove);

router.get('/batches/:batchId/students', validate({ params: s.batchIdParams, query: s.batchStudentsQuery }), ctrl.students);
router.post('/batches/:batchId/students', validate({ params: s.batchIdParams, body: s.studentIdsSchema }), ctrl.addStudents);
router.delete('/batches/:batchId/students/:studentId', validate({ params: s.batchStudentParams }), ctrl.removeStudent);

router.post('/batches/:batchId/courses', validate({ params: s.batchIdParams, body: s.courseSchema }), ctrl.addCourse);
router.delete('/batches/:batchId/courses/:courseId', validate({ params: s.batchCourseParams }), ctrl.removeCourse);
router.post('/batches/:batchId/professors', validate({ params: s.batchIdParams, body: s.professorSchema }), ctrl.assignProfessor);
router.delete('/batches/:batchId/professors/:professorId', validate({ params: s.batchProfessorParams }), ctrl.unassignProfessor);

// Learning material: which batches a module or video belongs to.
router.get('/batches/:batchId/materials', validate({ params: s.batchIdParams }), ctrl.materials);
router.put('/modules/:moduleId/batches', validate({ params: s.moduleIdParams, body: s.availabilitySchema }), ctrl.moduleAvailability);
router.put('/videos/:videoId/batches', validate({ params: s.videoIdParams, body: s.availabilitySchema }), ctrl.videoAvailability);

export default router;
