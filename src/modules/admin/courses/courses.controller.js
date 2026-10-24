import { created, send, sendPage } from '../../../utils/http.js';
import * as service from './courses.service.js';
import * as lecturers from './lecturers.service.js';
import * as timetable from './timetable.service.js';
import * as timetables from './timetableImport.service.js';

export async function list(req, res) {
  sendPage(res, await service.listCourses(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getCourse(req.valid.params.courseId));
}

export async function students(req, res) {
  sendPage(res, await service.listCourseStudents(req.valid.params.courseId, req.valid.query), req.valid.query);
}

export async function create(req, res) {
  created(res, await service.createCourse(req.valid.body, req.user));
}

export async function update(req, res) {
  send(res, await service.updateCourse(req.valid.params.courseId, req.valid.body, req.user));
}

export async function setStatus(req, res) {
  send(res, await service.setCourseStatus(req.valid.params.courseId, req.valid.body.isActive, req.user));
}

export async function addModule(req, res) {
  created(res, await service.addModule(req.valid.params.courseId, req.valid.body, req.user));
}

export async function updateModule(req, res) {
  send(res, await service.updateModule(req.valid.params.moduleId, req.valid.body, req.user));
}

export async function deleteModule(req, res) {
  await service.deleteModule(req.valid.params.moduleId, req.user);
  send(res, { deleted: true });
}

export async function reorderModules(req, res) {
  await service.reorderModules(req.valid.params.courseId, req.valid.body.ids);
  send(res, { reordered: true });
}

export async function addLesson(req, res) {
  created(res, await service.addLesson(req.valid.params.moduleId, req.valid.body, req.user));
}

export async function updateLesson(req, res) {
  send(res, await service.updateLesson(req.valid.params.lessonId, req.valid.body, req.user));
}

export async function deleteLesson(req, res) {
  await service.deleteLesson(req.valid.params.lessonId, req.user);
  send(res, { deleted: true });
}

export async function reorderLessons(req, res) {
  await service.reorderLessons(req.valid.params.moduleId, req.valid.body.ids);
  send(res, { reordered: true });
}

// Built-in course timetables

export async function timetableTemplates(req, res) {
  send(res, timetables.listTemplates());
}

/** A dry run returns only the summary (nothing was saved); an import also returns the course. */
export async function importTimetable(req, res) {
  const { course_id: courseId, summary } = await timetables.importTemplate(req.valid.params.key, req.valid.body, req.user);
  send(res, { summary, course: courseId ? await service.getCourse(courseId) : null });
}

export async function courseTimetable(req, res) {
  send(res, await timetable.getTimetable(req.valid.params.courseId, req.valid.query));
}

// Course lecturers

export async function addLecturer(req, res) {
  created(res, await lecturers.addLecturer(req.valid.params.courseId, req.valid.body, req.user));
}

export async function updateLecturer(req, res) {
  send(res, await lecturers.updateLecturer(req.valid.params.lecturerId, req.valid.body, req.user));
}

export async function deleteLecturer(req, res) {
  await lecturers.deleteLecturer(req.valid.params.lecturerId, req.user);
  send(res, { deleted: true });
}
