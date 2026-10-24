import pgSonography2026 from './pgSonography2026.js';

// Built-in course timetables an admin can import: course details, curriculum modules and topics, lecturer allocations
// and the weekly sessions.
export const TEMPLATES = [pgSonography2026];

export const findTemplate = (key) => TEMPLATES.find((t) => t.key === key) ?? null;

/** Every weekly session as { lecturer, week, module, title, review }, lecturer by lecturer. */
export const templateSessions = (t) =>
  t.lecturers.flatMap((l) =>
    t.sessions[l.key].map(([week, module, title, review]) => ({ lecturer: l.key, week, module, title, review: review ?? null })),
  );

/** What the import dialog shows about a template. */
export const templateSummary = (t) => ({
  key: t.key,
  name: t.name,
  course_title: t.course.title,
  academic_year: t.course.academicYear,
  start_date: t.course.startDate,
  end_date: t.course.endDate,
  duration_value: t.course.durationValue,
  duration_unit: t.course.durationUnit,
  module_count: t.curriculum.length,
  topic_count: t.curriculum.reduce((n, m) => n + m.topics.length, 0),
  session_count: templateSessions(t).length,
  lecturers: t.lecturers.map((l) => l.name),
  excluded_modules: t.curriculum.filter((m) => m.excluded).map((m) => m.title),
  missing: t.missing,
});
