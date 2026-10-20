import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { submitWebsiteEnquiry } from '../src/modules/enquiries/enquiries.service.js';
import { api, closeDatabase, resetDatabase, userWithToken } from './helpers.js';

let admin;
const valid = {
  name: 'Lakshmi N',
  email: 'lakshmi@example.com',
  phone: '+91 98400 11111',
  subject: 'Intake',
  message: 'When is the next intake?',
};

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
});
after(closeDatabase);

describe('website enquiry form', () => {
  it('stores the enquiry and notifies admins in-app', async () => {
    const res = await api().post('/api/enquiries').send(valid);
    assert.equal(res.status, 201);
    const { rows } = await pool.query('SELECT * FROM enquiries WHERE id = $1', [res.body.data.id]);
    assert.equal(rows[0].status, 'new');
    assert.equal(rows[0].source, 'website');
    const notes = await api().get('/api/notifications').set(admin.auth);
    assert.ok(notes.body.data.some((n) => n.type === 'enquiry_received'));
  });

  it('records the real email outcome — "skipped" when SMTP is not configured', async () => {
    const { enquiry, delivery } = await submitWebsiteEnquiry({ ...valid, courseInterest: null }, '127.0.0.1');
    const result = await delivery;
    assert.equal(result.status, 'skipped');
    const { rows } = await pool.query('SELECT email_status, email_error FROM enquiries WHERE id = $1', [enquiry.id]);
    assert.equal(rows[0].email_status, 'skipped');
    assert.match(rows[0].email_error, /SMTP/);
  });

  it('validates required fields and email format', async () => {
    const res = await api().post('/api/enquiries').send({ name: '', email: 'nope', message: '' });
    assert.equal(res.status, 422);
    assert.deepEqual(Object.keys(res.body.error.details).sort(), ['email', 'message', 'name']);
  });
});

describe('admin enquiry management', () => {
  it('lists, filters and moves enquiries through statuses with a follow-up timeline', async () => {
    const created = await api()
      .post('/api/enquiries')
      .send({ ...valid, name: 'Daniel B' });
    const id = created.body.data.id;

    const list = await api().get('/api/admin/enquiries?status=new&search=daniel').set(admin.auth);
    assert.equal(list.body.data.length, 1);

    const updated = await api().patch(`/api/admin/enquiries/${id}`).set(admin.auth).send({ status: 'follow_up', followUpOn: '2030-01-15' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'follow_up');
    assert.equal(updated.body.data.followUpOn, '2030-01-15');
    assert.match(updated.body.data.notes[0].note, /New to Follow-up/);

    const noted = await api().post(`/api/admin/enquiries/${id}/notes`).set(admin.auth).send({ note: 'Called, will visit campus' });
    assert.equal(noted.body.data.notes.length, 2);

    const counts = await api().get('/api/admin/enquiries/counts').set(admin.auth);
    assert.equal(counts.body.data.follow_up ?? counts.body.data.followUp, 1);
  });

  it('rejects invalid statuses', async () => {
    const res = await api().patch('/api/admin/enquiries/1').set(admin.auth).send({ status: 'spam' });
    assert.equal(res.status, 422);
  });
});
