import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeDatabase, createCourse, createModule, enrol, mp4Bytes, resetDatabase, uploadVideo, userWithToken } from './helpers.js';

let admin, student, outsider, course, video, draft;

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  student = await userWithToken('student');
  outsider = await userWithToken('student');
  course = await createCourse(admin.auth);
  const mod = await createModule(admin.auth, course.id, 'Physics');
  await enrol(admin.auth, course.id, [student.user.id]);
  video = await uploadVideo(admin.auth, { courseId: course.id, moduleId: mod.id, seconds: 95 });
  draft = await uploadVideo(admin.auth, { courseId: course.id, published: false, title: 'Draft' });
});
after(closeDatabase);

describe('video upload', () => {
  it('stores metadata in PostgreSQL and takes the duration from the MP4 itself', async () => {
    assert.equal(video.durationSeconds, 95, 'the browser-reported value (1) is overridden by the file');
    assert.equal(video.mimeType, 'video/mp4');
    assert.equal(video.storageKey, undefined, 'storage paths are never exposed');
  });

  it('rejects non-video files and mismatched content', async () => {
    const fake = await api()
      .post('/api/admin/videos')
      .set(admin.auth)
      .field('courseId', String(course.id))
      .field('title', 'Fake')
      .field('durationSeconds', '10')
      .attach('video', Buffer.from('not a video at all'), { filename: 'lecture.mp4', contentType: 'video/mp4' });
    assert.equal(fake.status, 415);

    const pdf = await api()
      .post('/api/admin/videos')
      .set(admin.auth)
      .field('courseId', String(course.id))
      .field('title', 'Pdf')
      .field('durationSeconds', '10')
      .attach('video', Buffer.from('%PDF-1.4'), { filename: 'notes.pdf', contentType: 'application/pdf' });
    assert.equal(pdf.status, 415);
  });

  it('validates that the module belongs to the course', async () => {
    const other = await createCourse(admin.auth);
    const foreign = await createModule(admin.auth, other.id, 'Elsewhere');
    const res = await api()
      .post('/api/admin/videos')
      .set(admin.auth)
      .field('courseId', String(course.id))
      .field('moduleId', String(foreign.id))
      .field('title', 'Wrong module')
      .field('durationSeconds', '10')
      .attach('video', mp4Bytes(10), { filename: 'x.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.moduleId);
  });
});

describe('video access', () => {
  it('hides unpublished videos and other courses from students', async () => {
    assert.equal((await api().get(`/api/student/videos/${draft.id}`).set(student.auth)).status, 404);
    assert.equal((await api().get(`/api/student/videos/${video.id}`).set(outsider.auth)).status, 404);
    const list = await api().get('/api/student/videos').set(student.auth);
    assert.deepEqual(
      list.body.data.map((v) => v.id),
      [video.id],
    );
  });

  it('streams through a signed URL with HTTP range support', async () => {
    const detail = await api().get(`/api/student/videos/${video.id}`).set(student.auth);
    assert.equal(detail.status, 200);
    const { url } = detail.body.data.stream;
    const res = await api().get(url).set('Range', 'bytes=0-99');
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.headers['content-length'], '100');
  });

  it('rejects missing, forged or mismatched media tokens', async () => {
    const detail = await api().get(`/api/student/videos/${video.id}`).set(student.auth);
    const token = new URL(detail.body.data.stream.url, 'http://x').searchParams.get('token');
    assert.equal((await api().get(`/api/media/videos/${video.id}/stream`)).status, 422);
    assert.equal((await api().get(`/api/media/videos/${video.id}/stream?token=${token.slice(0, -3)}xyz`)).status, 401);
    assert.equal((await api().get(`/api/media/videos/${draft.id}/stream?token=${token}`)).status, 403);
  });

  it('stops streaming when the video is unpublished', async () => {
    const detail = await api().get(`/api/student/videos/${video.id}`).set(student.auth);
    await api().patch(`/api/admin/videos/${video.id}/publish`).set(admin.auth).send({ isPublished: false }).expect(200);
    assert.equal((await api().get(detail.body.data.stream.url)).status, 404);
    await api().patch(`/api/admin/videos/${video.id}/publish`).set(admin.auth).send({ isPublished: true }).expect(200);
  });
});
