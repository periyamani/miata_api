import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import * as ctrl from './courses.controller.js';
import * as s from './courses.schemas.js';

const router = Router();

router.get('/courses', validate({ query: s.listCoursesQuery }), ctrl.list);
router.post('/courses', validate({ body: s.courseSchema }), ctrl.create);
router.get('/courses/:courseId', validate({ params: s.courseIdParams }), ctrl.get);
router.put('/courses/:courseId', validate({ params: s.courseIdParams, body: s.courseSchema }), ctrl.update);
router.patch('/courses/:courseId/status', validate({ params: s.courseIdParams, body: s.statusSchema }), ctrl.setStatus);
router.get('/courses/:courseId/students', validate({ params: s.courseIdParams, query: s.courseStudentsQuery }), ctrl.students);

router.post('/courses/:courseId/modules', validate({ params: s.courseIdParams, body: s.moduleSchema }), ctrl.addModule);
router.put('/courses/:courseId/modules/order', validate({ params: s.courseIdParams, body: s.orderSchema }), ctrl.reorderModules);
router.put('/modules/:moduleId', validate({ params: s.moduleIdParams, body: s.moduleSchema }), ctrl.updateModule);
router.delete('/modules/:moduleId', validate({ params: s.moduleIdParams }), ctrl.deleteModule);

router.post('/modules/:moduleId/lessons', validate({ params: s.moduleIdParams, body: s.lessonSchema }), ctrl.addLesson);
router.put('/modules/:moduleId/lessons/order', validate({ params: s.moduleIdParams, body: s.orderSchema }), ctrl.reorderLessons);
router.put('/lessons/:lessonId', validate({ params: s.lessonIdParams, body: s.lessonSchema }), ctrl.updateLesson);
router.delete('/lessons/:lessonId', validate({ params: s.lessonIdParams }), ctrl.deleteLesson);

export default router;
