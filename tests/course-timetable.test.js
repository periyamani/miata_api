import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { findTemplate, templateSessions } from '../src/modules/admin/courses/templates/index.js';
import { api, closeDatabase, createCourse, createModule, enrol, resetDatabase, userWithToken } from './helpers.js';

// Course timetables (migrations 015, 016): the 2026–2027 MIATA Postgraduate Sonography timetable imported into the
// course structure — curriculum modules and topics, course lecturers, and weekly sessions (lessons with a week and a
// lecturer in their module) — repeatably, without duplicates, reusing what a course already has.

const KEY = 'pg-sonography-2026-27';
const template = findTemplate(KEY);
const TITLES = template.curriculum.map((m) => m.title);
const TOPIC_COUNTS = [20, 18, 19, 16, 17, 14, 14, 15, 10, 11, 20, 12, 16, 10, 0];
const LECTURERS = ['Dr. Niveditha', 'Jai', 'Dr. Saranya', 'Dr. Suzmitha', 'Dr. Bagyavasan'];

let admin, professor, niveditha, course;

const importInto = (body) => api().post(`/api/admin/timetable-templates/${KEY}/import`).set(admin.auth).send(body);
const courseOf = async (id) => (await api().get(`/api/admin/courses/${id}`).set(admin.auth)).body.data;
const timetableOf = (id, query = {}) => api().get(`/api/admin/courses/${id}/timetable`).query(query).set(admin.auth);
const moduleOf = (c, title) => c.modules.find((m) => m.title === title);
const sessionsOf = (m) => m.lessons.filter((l) => l.weekNumber);
const topicsOf = (m) => m.lessons.filter((l) => !l.weekNumber);
const countRows = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  professor = await userWithToken('professor', { fullName: 'Other Professor' });
  niveditha = await userWithToken('professor', { fullName: 'Dr. Niveditha' }); // matched to the lecturer by name
  await userWithToken('professor', { fullName: 'Jai' });
  await userWithToken('professor', { fullName: 'Dr Jai' }); // two accounts named Jai: ambiguous, never linked
});
after(closeDatabase);

describe('database', () => {
  it('keeps lecturers on the course and the lecturer of each session on the lesson', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
          AND (table_name LIKE 'timetable%' OR table_name = 'course_lecturers'
               OR (table_name = 'modules' AND column_name IN ('lecturer_name', 'delivery_day', 'start_time', 'end_time', 'session_minutes'))
               OR (table_name = 'lessons' AND column_name IN ('week_number', 'course_lecturer_id')))`,
    );
    assert.equal(rows.filter((r) => r.table_name.startsWith('timetable')).length, 0, 'no separate timetable tables');
    assert.equal(rows.filter((r) => r.table_name === 'modules').length, 0, 'lecturers are no longer module columns');
    assert.equal(rows.filter((r) => r.table_name === 'lessons').length, 2);
    assert.ok(rows.some((r) => r.table_name === 'course_lecturers' && r.column_name === 'professor_id'));
  });
});

describe('timetable template', () => {
  it('holds the curriculum’s 14 modules with every topic, plus the revised timetable’s nerve module', () => {
    assert.equal(template.curriculum.length, 15);
    assert.deepEqual(
      template.curriculum.map((m) => m.topics.length),
      TOPIC_COUNTS,
    );
    assert.equal(TITLES[7], 'Echocardiography and Cardiac Ultrasound');
    assert.equal(template.curriculum[7].excluded, true);
    assert.equal(TITLES[14], 'Peripheral Nerve Sonography, Nerve Blocks and Neurosonography');
    assert.ok(template.curriculum[9].topics.includes('Focused cardiac assessment'), 'source topics are kept, cardiac ones included');
  });

  it('schedules 96 sessions: one per lecturer per week, in known modules, none in the excluded cardiac module', () => {
    const sessions = templateSessions(template);
    assert.equal(sessions.length, 96);
    const keys = new Set(template.curriculum.map((m) => m.key));
    for (const s of sessions) {
      assert.ok(keys.has(s.module), `${s.lecturer} week ${s.week}: module ${s.module}`);
      assert.notEqual(s.module, 'cardiac');
      assert.ok(s.week >= 1 && s.week <= 26);
    }
    assert.deepEqual(
      template.lecturers.map((l) => template.sessions[l.key].map(([w]) => w).join(',')),
      [26, 24, 8, 12, 26].map((n) => Array.from({ length: n }, (_, i) => i + 1).join(',')),
      'weeks 1–N in order: streams stop when their module is complete',
    );
    assert.deepEqual(
      template.lecturers.map((l) => [l.name, l.deliveryDay, l.sessionMinutes]),
      [
        ['Dr. Niveditha', 'sunday', 60],
        ['Jai', 'agreed', 60],
        ['Dr. Saranya', 'agreed', 60],
        ['Dr. Suzmitha', 'agreed', 60],
        ['Dr. Bagyavasan', 'weekday', 60],
      ],
    );
    // A session may carry exactly a topic's title (week 16 "Carotid and vertebral artery Doppler" is also Vascular topic 8),
    // which is why sessions are matched by module + week + lecturer, never by title alone.
    const same = sessions.filter((s) => template.curriculum.find((m) => m.key === s.module).topics.includes(s.title));
    assert.deepEqual(
      same.map((s) => [s.module, s.week, s.title]),
      [['vascular', 16, 'Carotid and vertebral artery Doppler']],
    );
  });

  it('is listed with its totals and what the documents leave open', async () => {
    const res = await api().get('/api/admin/timetable-templates').set(admin.auth);
    const [t] = res.body.data;
    assert.deepEqual(
      [t.courseTitle, t.academicYear, t.startDate, t.endDate, t.moduleCount, t.topicCount, t.sessionCount],
      ['MIATA Postgraduate Sonography', '2026–2027', '2026-10-19', '2027-04-18', 15, 212, 96],
    );
    assert.deepEqual(t.lecturers, LECTURERS);
    assert.deepEqual(t.excludedModules, ['Echocardiography and Cardiac Ultrasound']);
    assert.equal(t.missing.length, 3);
  });
});

describe('importing into a new course', () => {
  it('previews the import without saving anything (dry run)', async () => {
    const before = await Promise.all(['courses', 'modules', 'lessons', 'course_lecturers'].map(countRows));
    const res = await importInto({ code: 'PGS-2627', dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.course, null);
    assert.equal(res.body.data.summary.dryRun, true);
    assert.equal(res.body.data.summary.sessions.created, 96);
    assert.deepEqual(await Promise.all(['courses', 'modules', 'lessons', 'course_lecturers'].map(countRows)), before, 'nothing saved');
  });

  it('creates the course, curriculum, lecturers and sessions, and reports unmatched lecturers', async () => {
    let res = await importInto({});
    assert.equal(res.status, 422, 'a new course needs a code');
    res = await importInto({ code: 'pgs-2627', category: 'Postgraduate' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { summary } = res.body.data;
    course = res.body.data.course;

    assert.deepEqual(summary.course, { action: 'created', fieldsFilled: false });
    assert.deepEqual(
      summary.modules.map((m) => m.action),
      Array(15).fill('created'),
    );
    assert.deepEqual(summary.topics, { created: 212, unchanged: 0 });
    assert.deepEqual(summary.sessions, { created: 96, updated: 0, unchanged: 0, keptDifferent: [] });
    assert.deepEqual(
      summary.lecturers.map((l) => [l.name, l.action, l.professor.status]),
      [
        ['Dr. Niveditha', 'created', 'linked'],
        ['Jai', 'created', 'ambiguous'],
        ['Dr. Saranya', 'created', 'unmatched'],
        ['Dr. Suzmitha', 'created', 'unmatched'],
        ['Dr. Bagyavasan', 'created', 'unmatched'],
      ],
    );
    assert.equal(summary.lecturers[0].professor.professorId, niveditha.user.id);
    assert.equal(summary.lecturers[0].courseAllocated, false, 'no course allocation is created on their behalf');
    assert.equal(summary.lecturers[1].professor.candidates.length, 2);
    assert.equal(summary.review.length, 8, 'every judgement mapping is listed for review');
    assert.deepEqual(summary.excludedModules, ['Echocardiography and Cardiac Ultrasound']);

    assert.equal(course.title, 'MIATA Postgraduate Sonography');
    assert.deepEqual(
      [course.code, course.academicYear, course.startDate, course.endDate],
      ['PGS-2627', '2026–2027', '2026-10-19', '2027-04-18'],
    );
    assert.deepEqual([course.durationValue, course.durationUnit], [26, 'weeks']);
  });

  it('stores every module with its topics in source order, and each session in its module with its lecturer', async () => {
    assert.deepEqual(
      course.modules.map((m) => m.title),
      TITLES,
    );
    assert.deepEqual(
      course.modules.map((m) => topicsOf(m).length),
      TOPIC_COUNTS,
    );
    const physics = moduleOf(course, TITLES[0]);
    assert.deepEqual(
      topicsOf(physics).map((l) => l.title),
      template.curriculum[0].topics,
    );
    assert.ok(
      physics.lessons.slice(0, 20).every((l) => !l.weekNumber),
      'topics first, sessions after',
    );
    assert.deepEqual(
      sessionsOf(physics).map((l) => [l.weekNumber, l.lecturerName, l.durationMinutes]),
      [1, 2, 3, 4, 21, 24].map((w) => [w, 'Dr. Niveditha', 60]),
    );
    const gynae = moduleOf(course, 'Gynaecological Sonography');
    assert.deepEqual(
      sessionsOf(gynae).map((l) => [l.weekNumber, l.lecturerName]),
      [
        [1, 'Dr. Saranya'],
        [2, 'Dr. Saranya'],
        [3, 'Dr. Saranya'],
        [3, 'Dr. Bagyavasan'],
        [4, 'Dr. Saranya'],
        [8, 'Dr. Saranya'],
      ],
      'one module, two lecturers',
    );
    assert.equal(sessionsOf(moduleOf(course, 'Echocardiography and Cardiac Ultrasound')).length, 0, 'cardiac never scheduled');
    const carotid = moduleOf(course, 'Vascular Sonography and Doppler').lessons.filter(
      (l) => l.title === 'Carotid and vertebral artery Doppler',
    );
    assert.deepEqual(
      carotid.map((l) => l.weekNumber),
      [null, 16],
      'the topic and the week 16 session with the same title are both kept',
    );
    assert.equal(sessionsOf(moduleOf(course, TITLES[14])).length, 12);
    assert.deepEqual(
      course.lecturers.map((l) => [l.lecturerName, l.deliveryDay, l.sessionMinutes, l.firstWeek, l.lastWeek, l.sessionCount]),
      [
        ['Dr. Niveditha', 'sunday', 60, 1, 26, 26],
        ['Jai', 'agreed', 60, 1, 24, 24],
        ['Dr. Saranya', 'agreed', 60, 1, 8, 8],
        ['Dr. Suzmitha', 'agreed', 60, 1, 12, 12],
        ['Dr. Bagyavasan', 'weekday', 60, 1, 26, 26],
      ],
    );
    assert.equal(course.lecturers[0].professorName, 'Dr. Niveditha');
    assert.match(course.lecturers[4].allocation, /^One 1-hour session on a weekday each week/);
  });

  it('serves the weekly timetable: weeks, dates, sessions and filters', async () => {
    const res = await timetableOf(course.id);
    assert.equal(res.status, 200);
    const t = res.body.data;
    assert.equal(t.weekCount, 26);
    assert.equal(t.weeks.length, 26);
    assert.deepEqual(
      [t.weeks[0].startsOn, t.weeks[0].endsOn, t.weeks[25].startsOn, t.weeks[25].endsOn],
      ['2026-10-19', '2026-10-25', '2027-04-12', '2027-04-18'],
    );
    assert.deepEqual(
      [1, 8, 9, 12, 13, 24, 25, 26].map((n) => t.weeks[n - 1].sessions.length),
      [5, 5, 4, 4, 3, 3, 2, 2],
      'lecturer streams stop when their module is complete',
    );
    const week1 = t.weeks[0].sessions;
    assert.deepEqual(
      week1.map((s) => s.lecturerName),
      LECTURERS,
    );
    assert.equal(week1[0].title, 'SPI foundations: sound waves, frequency, wavelength and propagation');
    assert.equal(week1[0].moduleTitle, TITLES[0]);
    assert.equal(week1[0].moduleNumber, 1);
    assert.equal(t.modules.find((m) => m.title === 'Echocardiography and Cardiac Ultrasound').sessionCount, 0);

    const week11 = (await timetableOf(course.id, { week: 11 })).body.data;
    assert.deepEqual(
      week11.weeks.map((w) => [w.number, w.startsOn, w.endsOn, w.sessions.length]),
      [[11, '2026-12-28', '2027-01-03', 4]],
    );
    const gynae = moduleOf(course, 'Gynaecological Sonography');
    const byModule = (await timetableOf(course.id, { moduleId: gynae.id })).body.data;
    assert.equal(byModule.weeks.flatMap((w) => w.sessions).length, 6);
    const saranya = course.lecturers.find((l) => l.lecturerName === 'Dr. Saranya');
    const byLecturer = (await timetableOf(course.id, { lecturerId: saranya.id })).body.data;
    assert.deepEqual(
      byLecturer.weeks.filter((w) => w.sessions.length).map((w) => w.number),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const other = await createCourse(admin.auth, { code: 'OTHER-1' });
    const foreign = await createModule(admin.auth, other.id, 'Not in this course');
    assert.equal((await timetableOf(course.id, { moduleId: foreign.id })).status, 422);
  });

  it('importing again creates nothing and keeps an admin’s change', async () => {
    const session = sessionsOf(moduleOf(course, 'Musculoskeletal Sonography')).find((l) => l.weekNumber === 2);
    const edit = await api().put(`/api/admin/lessons/${session.id}`).set(admin.auth).send({
      title: 'Shoulder anatomy, rotator cuff and biceps',
      weekNumber: 2,
      courseLecturerId: session.courseLecturerId,
      durationMinutes: 60,
    });
    assert.equal(edit.status, 200);

    const before = await Promise.all(['modules', 'lessons', 'course_lecturers'].map(countRows));
    const res = await importInto({ courseId: course.id });
    assert.equal(res.status, 200);
    const { summary } = res.body.data;
    assert.deepEqual(summary.course, { action: 'reused', fieldsFilled: false });
    assert.ok(summary.modules.every((m) => m.action === 'reused'));
    assert.ok(summary.lecturers.every((l) => l.action === 'reused'));
    assert.deepEqual(summary.topics, { created: 0, unchanged: 212 });
    assert.equal(summary.sessions.created, 0);
    assert.equal(summary.sessions.unchanged, 95);
    assert.deepEqual(summary.sessions.keptDifferent, [
      { week: 2, lecturer: 'Jai', title: 'Shoulder anatomy and rotator cuff', existingTitle: 'Shoulder anatomy, rotator cuff and biceps' },
    ]);
    assert.deepEqual(await Promise.all(['modules', 'lessons', 'course_lecturers'].map(countRows)), before, 'no duplicates');
  });
});

describe('importing into an existing course', () => {
  let existing, physics, abdominal;

  before(async () => {
    existing = await createCourse(admin.auth, { code: 'PGDU', title: 'PG Diploma in Ultrasound' });
    physics = await createModule(admin.auth, existing.id, 'Ultrasound Physics & Instrumentation');
    abdominal = await createModule(admin.auth, existing.id, 'Abdominal  sonography'); // same title, other formatting
    await api().post(`/api/admin/modules/${abdominal.id}/lessons`).set(admin.auth).send({ title: 'Gallbladder and biliary tree' });
    // Assigned before the course had lecturers (any professor could be then): kept by the import, and reported.
    const assigned = await api()
      .post(`/api/admin/modules/${abdominal.id}/professors`)
      .set(admin.auth)
      .send({ professorId: professor.user.id });
    assert.equal(assigned.status, 201);
    await api()
      .post(`/api/admin/courses/${existing.id}/lecturers`)
      .set(admin.auth)
      .send({ lecturerName: 'Niveditha', deliveryDay: 'saturday' });
    await api()
      .post(`/api/admin/modules/${abdominal.id}/lessons`)
      .set(admin.auth)
      .send({ title: 'General sonography: liver, gallbladder and biliary system', weekNumber: 5 });
  });

  it('suggests similar modules in the preview instead of merging them', async () => {
    const res = await importInto({ courseId: existing.id, dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const modules = res.body.data.summary.modules;
    const physicsEntry = modules.find((m) => m.key === 'physics');
    assert.equal(physicsEntry.action, 'created');
    assert.deepEqual(physicsEntry.suggestions[0], { moduleId: physics.id, title: 'Ultrasound Physics & Instrumentation', similarity: 0.6 });
    assert.equal(modules.find((m) => m.key === 'abdominal').action, 'reused', 'formatting differences still match');
  });

  it('rejects mappings to modules outside the course or to one module twice', async () => {
    const other = await createCourse(admin.auth, { code: 'OTHER-2' });
    const foreign = await createModule(admin.auth, other.id, 'Foreign');
    let res = await importInto({ courseId: existing.id, moduleMap: { physics: foreign.id } });
    assert.equal(res.status, 422);
    res = await importInto({ courseId: existing.id, moduleMap: { physics: physics.id, abdominal: physics.id } });
    assert.equal(res.status, 422);
    assert.equal((await courseOf(existing.id)).modules.length, 2, 'nothing imported');
  });

  it('reuses mapped and matching modules, existing topics, lecturers and sessions', async () => {
    const res = await importInto({ courseId: existing.id, moduleMap: { physics: physics.id } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { summary, course: after } = res.body.data;
    assert.equal(summary.course.action, 'reused');
    assert.equal(summary.course.fieldsFilled, true);
    assert.equal(summary.modules.find((m) => m.key === 'physics').action, 'mapped');
    assert.equal(summary.modules.filter((m) => m.action === 'created').length, 13);
    assert.equal(summary.topics.unchanged, 1, 'the existing topic is reused');
    assert.equal(summary.sessions.updated, 1, 'the unassigned week 5 session gets its lecturer');
    assert.equal(summary.sessions.created, 95);
    const nivedithaEntry = summary.lecturers.find((l) => l.key === 'niveditha');
    assert.deepEqual([nivedithaEntry.action, nivedithaEntry.existingName], ['updated', 'Niveditha']);

    assert.equal(after.title, 'PG Diploma in Ultrasound', 'the course keeps its name');
    assert.equal(after.modules.length, 15);
    assert.equal(
      after.modules.find((m) => m.id === physics.id).title,
      'Ultrasound Physics & Instrumentation',
      'the mapped module keeps its name',
    );
    const lecturer = after.lecturers.find((l) => l.lecturerName === 'Niveditha');
    assert.equal(lecturer.deliveryDay, 'saturday', 'what the admin entered is kept');
    assert.match(lecturer.allocation, /^Sunday — /, 'missing allocation filled in');
    assert.equal(lecturer.professorId, niveditha.user.id, 'linked to the matching account');
    const abd = after.modules.find((m) => m.id === abdominal.id);
    assert.deepEqual(summary.moduleProfessors.notLecturers, [{ module: 'Abdominal  sonography', professor: 'Other Professor' }]);
    assert.deepEqual(
      abd.professors.map((p) => p.fullName).sort(),
      ['Dr. Niveditha', 'Other Professor'],
      'the existing assignment is kept; the lecturer is added',
    );
    assert.equal(abd.lessons.filter((l) => l.title === 'Gallbladder and biliary tree').length, 1);
    assert.equal(abd.lessons.find((l) => l.weekNumber === 5).courseLecturerId, lecturer.id);
  });
});

describe('editing lecturers and sessions', () => {
  let guest;

  it('adds, validates and removes course lecturers', async () => {
    let res = await api()
      .post(`/api/admin/courses/${course.id}/lecturers`)
      .set(admin.auth)
      .send({ lecturerName: 'Dr. Guest', deliveryDay: 'friday', startTime: '18:00', endTime: '19:00', sessionMinutes: 60 });
    assert.equal(res.status, 201);
    guest = res.body.data;
    assert.deepEqual([guest.startTime, guest.endTime], ['18:00:00', '19:00:00']);
    res = await api().post(`/api/admin/courses/${course.id}/lecturers`).set(admin.auth).send({ lecturerName: 'dr. guest' });
    assert.equal(res.status, 409);
    res = await api()
      .put(`/api/admin/course-lecturers/${guest.id}`)
      .set(admin.auth)
      .send({ lecturerName: 'Dr. Guest', professorId: admin.user.id });
    assert.equal(res.status, 422, 'only professors can be linked');
    res = await api()
      .put(`/api/admin/course-lecturers/${guest.id}`)
      .set(admin.auth)
      .send({ lecturerName: 'Dr. Guest', startTime: '18:00', endTime: '17:00' });
    assert.equal(res.status, 422);
  });

  it('keeps sessions within the course, its lecturers and its weeks', async () => {
    const msk = moduleOf(course, 'Musculoskeletal Sonography');
    const add = (body) =>
      api()
        .post(`/api/admin/modules/${msk.id}/lessons`)
        .set(admin.auth)
        .send({ title: 'Guest session', ...body });
    const otherLecturer = (
      await courseOf((await api().get('/api/admin/courses').query({ search: 'PGDU' }).set(admin.auth)).body.data[0].id)
    ).lecturers[0];
    assert.equal((await add({ weekNumber: 25, courseLecturerId: otherLecturer.id })).status, 422, 'a lecturer of another course');
    assert.equal((await add({ courseLecturerId: guest.id })).status, 422, 'a lecturer’s session needs a week');
    assert.equal((await add({ weekNumber: 27, courseLecturerId: guest.id })).status, 422, 'beyond the course’s 26 weeks');
    const res = await add({ weekNumber: 25, courseLecturerId: guest.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.courseLecturerId, guest.id);

    const del = await api().delete(`/api/admin/course-lecturers/${guest.id}`).set(admin.auth);
    assert.equal(del.status, 200);
    const lesson = (await courseOf(course.id)).modules.flatMap((m) => m.lessons).find((l) => l.id === res.body.data.id);
    assert.deepEqual([lesson.weekNumber, lesson.courseLecturerId], [25, null], 'the session stays, without a lecturer');
  });

  it('keeps the course long enough for its sessions; the plain course form still works', async () => {
    const c = await courseOf(course.id);
    const body = {
      code: c.code,
      title: c.title,
      durationValue: c.durationValue,
      durationUnit: c.durationUnit,
      academicYear: c.academicYear,
      startDate: c.startDate,
      endDate: '2027-03-01',
    };
    let res = await api().put(`/api/admin/courses/${c.id}`).set(admin.auth).send(body);
    assert.equal(res.status, 422);
    assert.match(res.body.error.details.endDate, /week 26/);
    res = await api()
      .post('/api/admin/courses')
      .set(admin.auth)
      .send({ code: 'PLAIN', title: 'Plain course', durationValue: 3, durationUnit: 'months' });
    assert.equal(res.status, 201);
    res = await api().post(`/api/admin/courses/${res.body.data.id}/modules`).set(admin.auth).send({ title: 'Plain module' });
    assert.equal(res.status, 201);
  });

  it('only admins import and edit timetables', async () => {
    assert.equal((await api().get('/api/admin/timetable-templates').set(professor.auth)).status, 403);
    assert.equal((await api().post(`/api/admin/timetable-templates/${KEY}/import`).set(professor.auth).send({ code: 'NOPE' })).status, 403);
    assert.equal((await api().get(`/api/admin/courses/${course.id}/timetable`).set(professor.auth)).status, 403);
  });
});

describe('module professors follow the timetable', () => {
  const professorsOf = async (title) => moduleOf(await courseOf(course.id), title).professors.map((p) => p.fullName);

  it('assigns a linked lecturer to the modules they teach, and only those', async () => {
    const c = await courseOf(course.id);
    const nivedithaModules = c.modules.filter((m) => m.professors.some((p) => p.id === niveditha.user.id)).map((m) => m.title);
    assert.deepEqual(nivedithaModules, [TITLES[0], TITLES[1], TITLES[2], TITLES[4]], 'physics, abdominal, obstetric, vascular');
    assert.deepEqual(await professorsOf('Gynaecological Sonography'), [], 'Dr. Saranya has no account yet');
    assert.deepEqual(await professorsOf('Echocardiography and Cardiac Ultrasound'), [], 'nobody teaches the cardiac module');
  });

  it('only lets the course’s lecturers be assigned to its modules (other courses unchanged)', async () => {
    const msk = moduleOf(await courseOf(course.id), 'Musculoskeletal Sonography');
    let res = await api().post(`/api/admin/modules/${msk.id}/professors`).set(admin.auth).send({ professorId: professor.user.id });
    assert.equal(res.status, 422);
    assert.match(res.body.error.details.professorId, /course’s lecturers/);
    res = await api().post(`/api/admin/modules/${msk.id}/professors`).set(admin.auth).send({ professorId: niveditha.user.id });
    assert.equal(res.status, 201, 'a lecturer of the course may be assigned to any of its modules');
    const plain = await createCourse(admin.auth, { code: 'NO-LECT' });
    const plainModule = await createModule(admin.auth, plain.id, 'Any module');
    res = await api().post(`/api/admin/modules/${plainModule.id}/professors`).set(admin.auth).send({ professorId: professor.user.id });
    assert.equal(res.status, 201, 'a course without lecturers accepts any professor, as before');
  });

  it('linking a lecturer to an account assigns them to their modules', async () => {
    const saranyaAccount = await userWithToken('professor', { fullName: 'Saranya R' }); // name differs: linked by hand
    const lecturer = (await courseOf(course.id)).lecturers.find((l) => l.lecturerName === 'Dr. Saranya');
    const res = await api()
      .put(`/api/admin/course-lecturers/${lecturer.id}`)
      .set(admin.auth)
      .send({
        lecturerName: lecturer.lecturerName,
        professorId: saranyaAccount.user.id,
        allocation: lecturer.allocation,
        deliveryDay: 'agreed',
        sessionMinutes: 60,
      });
    assert.equal(res.status, 200);
    assert.deepEqual(await professorsOf('Gynaecological Sonography'), ['Saranya R']);
    assert.deepEqual(await professorsOf('Small Parts and Superficial Sonography'), ['Saranya R'], 'her breast sessions');
    assert.deepEqual(await professorsOf('Musculoskeletal Sonography'), ['Dr. Niveditha'], 'nothing else changed');
  });
});

describe('timetables for professors and students', () => {
  it('shows professors the courses they lecture in, with their own lecturer rows and no account details', async () => {
    const res = await api().get('/api/professor/timetable').set(niveditha.auth);
    assert.equal(res.status, 200);
    const t = res.body.data.find((x) => x.course.id === course.id);
    assert.ok(t, 'the course she lectures in');
    const mine = t.lecturers.find((l) => l.lecturerName === 'Dr. Niveditha');
    assert.deepEqual(t.myLecturerIds, [mine.id]);
    assert.equal(t.weeks.length, 26);
    assert.ok(
      t.lecturers.every((l) => !('professorEmail' in l) && !('professorId' in l)),
      'no account details',
    );
    const other = await api().get('/api/professor/timetable').set(professor.auth);
    assert.ok(!other.body.data.some((x) => x.course.id === course.id), 'not a professor of this course');
  });

  it('shows students the timetable of the courses they are enrolled in, without modules restricted to other batches', async () => {
    const student = await userWithToken('student', { fullName: 'Enrolled Student' });
    const outsider = await userWithToken('student', { fullName: 'Not Enrolled' });
    await enrol(admin.auth, course.id, [student.user.id]);
    const all = (await timetableOf(course.id)).body.data.weeks.flatMap((w) => w.sessions);

    let res = await api().get('/api/student/timetable').set(student.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].weeks.flatMap((w) => w.sessions).length, all.length);

    const msk = moduleOf(await courseOf(course.id), 'Musculoskeletal Sonography');
    const batch = await api()
      .post('/api/admin/batches')
      .set(admin.auth)
      .send({ code: 'OTHER-BATCH', name: 'Other batch', courseIds: [course.id] });
    const restrict = await api()
      .put(`/api/admin/modules/${msk.id}/batches`)
      .set(admin.auth)
      .send({ batchIds: [batch.body.data.id] });
    assert.equal(restrict.status, 200);
    res = await api().get('/api/student/timetable').set(student.auth);
    const sessions = res.body.data[0].weeks.flatMap((w) => w.sessions);
    assert.equal(sessions.length, all.filter((s) => s.moduleId !== msk.id).length, 'MSK is for another batch');
    assert.ok(!res.body.data[0].modules.some((m) => m.id === msk.id));

    assert.deepEqual((await api().get('/api/student/timetable').set(outsider.auth)).body.data, [], 'not enrolled');
    assert.equal((await api().get('/api/student/timetable').set(niveditha.auth)).status, 403);
    assert.equal((await api().get('/api/professor/timetable').set(student.auth)).status, 403);
  });
});
