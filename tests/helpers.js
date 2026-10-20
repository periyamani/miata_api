import fs from 'node:fs/promises';
import request from 'supertest';
import { env } from '../src/config/env.js';
import { pool, withTransaction } from '../src/config/db.js';
import { ensureDatabase, runMigrations } from '../src/config/migrator.js';
import { createApp } from '../src/app.js';
import { ensureUploadDirs } from '../src/services/storage.service.js';
import { createAccount } from '../src/modules/users/user.repository.js';

export const PASSWORD = 'Testing123';
export const app = createApp();
export const api = () => request(app);

/** Recreate the schema from migrations. Refuses to run against anything but the mock database. */
export async function resetDatabase() {
  if (!env.isTest || env.db.database !== env.databases.mock || env.db.database === env.databases.live) {
    throw new Error(`Refusing to reset database "${env.db.database}" — tests must use the mock database`);
  }
  await ensureDatabase(env.db.database);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations({ log: () => {} });
  await fs.rm(env.uploads.dir, { recursive: true, force: true });
  await ensureUploadDirs();
}

export async function closeDatabase() {
  await pool.end();
}

let counter = 0;
/** Create a user directly (bypassing the API). Returns the user row. */
export async function createUser(role, overrides = {}) {
  counter += 1;
  const email = overrides.email ?? `${role}${counter}@test.local`;
  return withTransaction((db) =>
    createAccount(
      {
        role,
        email,
        fullName: overrides.fullName ?? `${role[0].toUpperCase()}${role.slice(1)} ${counter}`,
        password: overrides.password ?? PASSWORD,
        mustResetPassword: overrides.mustResetPassword ?? false,
        resetReason: overrides.mustResetPassword ? 'account_created' : null,
      },
      db,
    ),
  );
}

/** Log in through the API. Returns { token, cookie, body }. */
export async function login(email, password = PASSWORD) {
  const res = await api().post('/api/auth/login').send({ email, password });
  if (res.status !== 200 || !res.body.data?.accessToken) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.data.accessToken, cookie: res.headers['set-cookie'], body: res.body };
}

export async function userWithToken(role, overrides) {
  const user = await createUser(role, overrides);
  const { token } = await login(user.email, overrides?.password);
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}

// ─── Fixtures ──────────────────────────────────────────────────────────

export async function createCourse(adminAuth, overrides = {}) {
  counter += 1;
  const res = await api()
    .post('/api/admin/courses')
    .set(adminAuth)
    .send({ code: `C${counter}`, title: `Course ${counter}`, durationValue: 3, durationUnit: 'months', ...overrides });
  if (res.status !== 201) throw new Error(`createCourse: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function createModule(adminAuth, courseId, title = 'Module') {
  const res = await api().post(`/api/admin/courses/${courseId}/modules`).set(adminAuth).send({ title });
  return res.body.data;
}

/** Assignments are authored by professors, within the courses/modules they teach. */
export async function createAssignment(professorAuth, fields) {
  const req = api().post('/api/professor/assignments').set(professorAuth);
  for (const [k, v] of Object.entries({ title: 'Case report', isPublished: 'true', isRequired: 'true', ...fields })) {
    if (v !== null && v !== undefined) req.field(k, String(v));
  }
  const res = await req;
  if (res.status !== 201) throw new Error(`createAssignment: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function enrol(adminAuth, courseId, studentIds) {
  const res = await api().post(`/api/admin/courses/${courseId}/enrolments`).set(adminAuth).send({ studentIds });
  if (res.status !== 201) throw new Error(`enrol: ${JSON.stringify(res.body)}`);
}

export async function assignProfessor(adminAuth, courseId, professorId) {
  const res = await api().post(`/api/admin/courses/${courseId}/professors`).set(adminAuth).send({ professorId });
  if (res.status !== 201) throw new Error(`assignProfessor: ${JSON.stringify(res.body)}`);
}

// ─── Fixture files ─────────────────────────────────────────────────────

export const pdfBytes = (text = 'test') =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');

/** Smallest MP4 our validators accept: an ftyp box and a moov/mvhd box declaring `seconds` of duration. */
export function mp4Bytes(seconds = 120) {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftypisom', 4, 'latin1');
  ftyp.write('isomisommp42'.slice(0, 12), 12, 'latin1');
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 20); // timescale
  mvhd.writeUInt32BE(seconds * 1000, 24); // duration
  const moovHeader = Buffer.alloc(8);
  moovHeader.writeUInt32BE(8 + mvhd.length, 0);
  moovHeader.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, moovHeader, mvhd, Buffer.alloc(2048)]);
}

export async function uploadVideo(adminAuth, { courseId, moduleId, seconds = 120, published = true, title = 'Lecture' }) {
  const req = api()
    .post('/api/admin/videos')
    .set(adminAuth)
    .field('courseId', String(courseId))
    .field('title', title)
    .field('durationSeconds', '1')
    .field('isPublished', String(published))
    .attach('video', mp4Bytes(seconds), { filename: 'lecture.mp4', contentType: 'video/mp4' });
  if (moduleId) req.field('moduleId', String(moduleId));
  const res = await req;
  if (res.status !== 201) throw new Error(`uploadVideo: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Pretend the previous heartbeat happened `seconds` ago (lets tests simulate real playback time). */
export async function ageHeartbeat(videoId, studentId, seconds) {
  await pool.query(
    `UPDATE video_progress SET last_heartbeat_at = now() - make_interval(secs => $3) WHERE video_id = $1 AND student_id = $2`,
    [videoId, studentId, seconds],
  );
}

/** Watch a whole video the honest way: 10-second heartbeats, 10 real seconds apart. */
export async function watchVideo(auth, studentId, video) {
  for (let position = 0; position <= video.durationSeconds + 10; position += 10) {
    await ageHeartbeat(video.id, studentId, 10);
    const res = await api()
      .post(`/api/student/videos/${video.id}/progress`)
      .set(auth)
      .send({ position: Math.min(position, video.durationSeconds) });
    if (res.status !== 200) return res;
    if (res.body.data.courseCompleted || res.body.data.videoCompleted) return res;
  }
  throw new Error('Video never completed');
}
