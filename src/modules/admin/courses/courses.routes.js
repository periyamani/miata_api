import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import * as ctrl from './courses.controller.js';
import * as s from './courses.schemas.js';

const router = Router();

// Built-in course timetables (e.g. the 2026–2027 postgraduate sonography timetable): list, and import into a course.
router.get('/timetable-templates', ctrl.timetableTemplates);
router.post(
  '/timetable-templates/:key/import',
  validate({ params: s.templateKeyParams, body: s.importTimetableSchema }),
  ctrl.importTimetable,
);

router.get('/courses', validate({ query: s.listCoursesQuery }), ctrl.list);
router.post('/courses', validate({ body: s.courseSchema }), ctrl.create);
router.get('/courses/:courseId', validate({ params: s.courseIdParams }), ctrl.get);
router.put('/courses/:courseId', validate({ params: s.courseIdParams, body: s.courseSchema }), ctrl.update);
router.patch('/courses/:courseId/status', validate({ params: s.courseIdParams, body: s.statusSchema }), ctrl.setStatus);
router.get('/courses/:courseId/students', validate({ params: s.courseIdParams, query: s.courseStudentsQuery }), ctrl.students);
// Weekly timetable (optionally one week, module or lecturer) and the course's lecturers.
router.get('/courses/:courseId/timetable', validate({ params: s.courseIdParams, query: s.timetableQuery }), ctrl.courseTimetable);
router.post('/courses/:courseId/lecturers', validate({ params: s.courseIdParams, body: s.lecturerSchema }), ctrl.addLecturer);
router.put('/course-lecturers/:lecturerId', validate({ params: s.lecturerIdParams, body: s.lecturerSchema }), ctrl.updateLecturer);
router.delete('/course-lecturers/:lecturerId', validate({ params: s.lecturerIdParams }), ctrl.deleteLecturer);

router.post('/courses/:courseId/modules', validate({ params: s.courseIdParams, body: s.moduleSchema }), ctrl.addModule);
router.put('/courses/:courseId/modules/order', validate({ params: s.courseIdParams, body: s.orderSchema }), ctrl.reorderModules);
router.put('/modules/:moduleId', validate({ params: s.moduleIdParams, body: s.moduleSchema }), ctrl.updateModule);
router.delete('/modules/:moduleId', validate({ params: s.moduleIdParams }), ctrl.deleteModule);

router.post('/modules/:moduleId/lessons', validate({ params: s.moduleIdParams, body: s.lessonSchema }), ctrl.addLesson);
router.put('/modules/:moduleId/lessons/order', validate({ params: s.moduleIdParams, body: s.orderSchema }), ctrl.reorderLessons);
router.put('/lessons/:lessonId', validate({ params: s.lessonIdParams, body: s.lessonSchema }), ctrl.updateLesson);
router.delete('/lessons/:lessonId', validate({ params: s.lessonIdParams }), ctrl.deleteLesson);

export default router;
