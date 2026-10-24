import { pool } from '../../../config/db.js';
import { AppError, conflict, notFound } from '../../../utils/AppError.js';
import { weeksInRange } from '../../../utils/dates.js';
import { logActivity } from '../../../services/activity.service.js';
import * as repo from './courses.repository.js';
import * as curriculum from './curriculum.repository.js';
import * as lecturersRepo from './lecturers.repository.js';
import { assignLecturerModules } from './lecturers.service.js';
import { findTemplate, TEMPLATES, templateSessions, templateSummary } from './templates/index.js';

// Import a built-in course timetable into a course: its timetable details, the curriculum modules and topics, the
// lecturer allocations and the weekly sessions (lessons with a week and a lecturer, in their module). Safe to repeat:
//   course    the course chosen by the admin, or a new one with the code they enter
//   modules   exact title (case, '&' / 'and' and punctuation ignored), or the existing module the admin maps it to;
//             similar titles are only suggested, never merged on their own
//   lecturers name (titles such as "Dr." ignored); linked to a professor account only when exactly one matches
//   sessions  module + week + lecturer (not the title, which may repeat in another module)
//   topics    title within the module, among lessons not already matched as sessions
//   module professors  each linked lecturer's professor, for the modules in which they teach (added, never removed)
// Existing records are never overwritten: only empty fields are filled in, and differences are reported.
// A dry run performs the same import in a transaction that is rolled back, so the preview is exactly what happens.

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

const normalise = (text) =>
  text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const personName = (name) => normalise(name).replace(/^(dr|prof|professor|mr|mrs|ms|miss) /, '');

// Words that mean the same in module titles, and words that carry no meaning, for suggesting similar modules.
const SYNONYMS = {
  ultrasound: 'sonography',
  gynecology: 'gynaecology',
  gynaecological: 'gynaecology',
  gynecological: 'gynaecology',
  obstetrics: 'obstetric',
  pediatric: 'paediatric',
  msk: 'musculoskeletal',
};
const STOPWORDS = new Set(['and', 'of', 'the', 'in', 'for', 'to', 'a']);
const words = (title) =>
  new Set(
    normalise(title)
      .split(' ')
      .filter((w) => w && !STOPWORDS.has(w))
      .map((w) => SYNONYMS[w] ?? w),
  );
function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared || 1);
}

export const listTemplates = () => TEMPLATES.map(templateSummary);

/** Resolve the course: the chosen one (its empty timetable fields filled in) or a new one with the template heading. */
async function resolveCourse(db, template, { courseId, code, category }, actor, summary) {
  if (courseId) {
    if (!(await repo.findCourse(courseId, db))) throw notFound('Course');
    summary.course.action = 'reused';
    summary.course.fields_filled = Boolean(await repo.fillCourseSchedule(courseId, template.course, db));
    const course = await repo.findCourse(courseId, db);
    const weeksNeeded = Math.max(...templateSessions(template).map((s) => s.week));
    if (course.start_date && course.end_date && weeksInRange(course.start_date, course.end_date) < weeksNeeded) {
      throw invalid('courseId', `This course's dates cover fewer than the ${weeksNeeded} weeks of the timetable`);
    }
    return course;
  }
  if (await repo.codeTaken(code, null, db))
    throw conflict('A course with this code already exists', { code: 'This course code is already in use' });
  summary.course.action = 'created';
  return repo.insertCourse({ ...template.course, code, category, feeAmount: null, isActive: true }, actor.id, db);
}

/** Match or create every curriculum module; returns { key: module } (module with its existing lessons). */
async function resolveModules(db, template, course, moduleMap, summary) {
  const existing = await repo.courseCurriculum(course.id, db);
  const claimed = new Set();
  const modules = {};
  for (const m of template.curriculum) {
    let found = null;
    let action;
    if (Object.hasOwn(moduleMap, m.key) && moduleMap[m.key] !== null) {
      found = existing.find((e) => e.id === moduleMap[m.key]);
      if (!found) throw invalid('moduleMap', `“${m.title}” is mapped to a module that is not part of this course`);
      if (claimed.has(found.id)) throw invalid('moduleMap', `“${found.title}” is mapped to more than one curriculum module`);
      action = 'mapped';
    } else if (!Object.hasOwn(moduleMap, m.key)) {
      found = existing.find((e) => !claimed.has(e.id) && normalise(e.title) === normalise(m.title)) ?? null;
      action = found ? 'reused' : 'created';
    } else {
      action = 'created';
    }

    const entry = {
      key: m.key,
      title: m.title,
      action,
      excluded: Boolean(m.excluded),
      from_revised_timetable: Boolean(m.fromRevisedTimetable),
    };
    if (found) {
      claimed.add(found.id);
      entry.module_id = found.id;
      entry.existing_title = found.title;
      entry.description_filled = await curriculum.fillModuleDescription(found.id, m.description ?? null, db);
      modules[m.key] = { id: found.id, lessons: found.lessons };
    } else {
      const created = await curriculum.insertModule(course.id, { title: m.title, description: m.description ?? null }, db);
      entry.module_id = created.id;
      modules[m.key] = { id: created.id, lessons: [] };
    }
    summary.modules.push(entry);
  }
  // Suggest similar existing modules for the ones created, so an admin can map them instead (dry run first).
  for (const entry of summary.modules.filter((e) => e.action === 'created')) {
    entry.suggestions = existing
      .filter((e) => !claimed.has(e.id))
      .map((e) => ({ module_id: e.id, title: e.title, similarity: Math.round(similarity(entry.title, e.title) * 100) / 100 }))
      .filter((s) => s.similarity >= 0.3)
      .sort((a, b) => b.similarity - a.similarity);
  }
  return modules;
}

/** Match or create the course lecturers; link each to a professor account only when exactly one has their name. */
async function resolveLecturers(db, template, course, summary) {
  const existing = await lecturersRepo.courseLecturers(course.id, db);
  const accounts = await lecturersRepo.professorAccounts(db);
  const ids = {};
  for (const l of template.lecturers) {
    const candidates = accounts.filter((a) => personName(a.full_name) === personName(l.name));
    const found = existing.find((e) => personName(e.lecturer_name) === personName(l.name));
    const entry = { key: l.key, name: l.name };

    let professorId = null;
    if (found?.professor_id) entry.professor = { status: 'already_linked', professor_id: found.professor_id, name: found.professor_name };
    else if (candidates.length === 1) {
      professorId = candidates[0].id;
      entry.professor = { status: 'linked', professor_id: professorId, name: candidates[0].full_name };
    } else if (candidates.length > 1) {
      entry.professor = { status: 'ambiguous', candidates: candidates.map((c) => ({ professor_id: c.id, name: c.full_name })) };
    } else entry.professor = { status: 'unmatched' };

    const data = {
      lecturerName: l.name,
      professorId,
      allocation: l.allocation,
      deliveryDay: l.deliveryDay,
      sessionMinutes: l.sessionMinutes,
    };
    if (found) {
      ids[l.key] = found.id;
      entry.lecturer_id = found.id;
      entry.action = (await lecturersRepo.fillLecturer(found.id, data, db)) ? 'updated' : 'reused';
      if (found.lecturer_name !== l.name) entry.existing_name = found.lecturer_name;
    } else {
      ids[l.key] = (await lecturersRepo.insertLecturer(course.id, data, db)).id;
      entry.lecturer_id = ids[l.key];
      entry.action = 'created';
    }
    summary.lecturers.push(entry);
  }
  return ids;
}

/** Topics and sessions of every module: match existing lessons, then add what is missing (topics first). */
async function resolveLessons(db, template, modules, lecturerIds, summary) {
  const sessions = templateSessions(template);
  for (const m of template.curriculum) {
    const { id: moduleId, lessons } = modules[m.key];
    const claimed = new Set();
    const newSessions = [];
    for (const s of sessions.filter((x) => x.module === m.key)) {
      const lecturerId = lecturerIds[s.lecturer];
      const exact = lessons.find((l) => !claimed.has(l.id) && l.week_number === s.week && l.course_lecturer_id === lecturerId);
      if (exact) {
        claimed.add(exact.id);
        if (normalise(exact.title) === normalise(s.title)) summary.sessions.unchanged += 1;
        else summary.sessions.kept_different.push({ week: s.week, lecturer: s.lecturer, title: s.title, existing_title: exact.title });
        continue;
      }
      const unassigned = lessons.find(
        (l) => !claimed.has(l.id) && l.week_number === s.week && l.course_lecturer_id === null && normalise(l.title) === normalise(s.title),
      );
      if (unassigned) {
        claimed.add(unassigned.id);
        await curriculum.fillSessionLecturer(unassigned.id, lecturerId, db);
        summary.sessions.updated += 1;
        continue;
      }
      newSessions.push({ ...s, lecturerId });
    }

    for (const title of m.topics) {
      const hit = lessons.find((l) => !claimed.has(l.id) && normalise(l.title) === normalise(title));
      if (hit) {
        claimed.add(hit.id);
        summary.topics.unchanged += 1;
      } else {
        await curriculum.insertLesson(moduleId, { title, content: null, durationMinutes: null }, db);
        summary.topics.created += 1;
      }
    }
    for (const s of newSessions.sort((a, b) => a.week - b.week)) {
      const minutes = template.lecturers.find((l) => l.key === s.lecturer).sessionMinutes;
      await curriculum.insertLesson(
        moduleId,
        { title: s.title, content: null, durationMinutes: minutes, weekNumber: s.week, courseLecturerId: s.lecturerId },
        db,
      );
      summary.sessions.created += 1;
    }
  }
  const lecturerName = (key) => template.lecturers.find((l) => l.key === key).name;
  summary.sessions.kept_different = summary.sessions.kept_different.map((d) => ({ ...d, lecturer: lecturerName(d.lecturer) }));
  summary.review = sessions
    .filter((s) => s.review)
    .map((s) => ({
      week: s.week,
      lecturer: lecturerName(s.lecturer),
      title: s.title,
      module: template.curriculum.find((m) => m.key === s.module).title,
      note: s.review,
    }));
}

export async function importTemplate(key, { courseId = null, code = null, category = null, dryRun = false, moduleMap = {} }, actor) {
  const template = findTemplate(key);
  if (!template) throw notFound('Timetable template');
  const summary = {
    dry_run: dryRun,
    course: { action: null, fields_filled: false },
    modules: [],
    lecturers: [],
    topics: { created: 0, unchanged: 0 },
    sessions: { created: 0, updated: 0, unchanged: 0, kept_different: [] },
    review: [],
    excluded_modules: template.curriculum.filter((m) => m.excluded).map((m) => m.title),
    missing: template.missing,
    module_professors: { assigned: [], not_lecturers: [] },
  };

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const course = await resolveCourse(db, template, { courseId, code, category }, actor, summary);
    const modules = await resolveModules(db, template, course, moduleMap, summary);
    const lecturerIds = await resolveLecturers(db, template, course, summary);
    await resolveLessons(db, template, modules, lecturerIds, summary);
    // Linked lecturers become the professors of the modules they teach (only added; others are reported, never removed).
    const assigned = await assignLecturerModules(db, course.id, actor);
    summary.module_professors = {
      assigned: assigned.map((a) => ({ module: a.module_title, professor: a.professor_name })),
      not_lecturers: (await lecturersRepo.nonLecturerModuleProfessors(course.id, db)).map((r) => ({
        module: r.module_title,
        professor: r.professor_name,
      })),
    };
    for (const entry of summary.lecturers) {
      const pid = entry.professor.professor_id;
      entry.course_allocated = pid
        ? (await db.query('SELECT 1 FROM professor_course_assignments WHERE course_id = $1 AND professor_id = $2', [course.id, pid]))
            .rowCount > 0
        : false;
    }
    await logActivity(
      {
        actorId: actor.id,
        action: 'course.timetable_imported',
        entityType: 'course',
        entityId: course.id,
        description: `Timetable "${template.name}" imported into ${course.title}`,
        metadata: {
          template: template.key,
          modulesCreated: summary.modules.filter((m) => m.action === 'created').length,
          topicsCreated: summary.topics.created,
          sessionsCreated: summary.sessions.created,
          lecturersCreated: summary.lecturers.filter((l) => l.action === 'created').length,
        },
      },
      db,
    );
    await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { course_id: dryRun ? null : course.id, summary };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
