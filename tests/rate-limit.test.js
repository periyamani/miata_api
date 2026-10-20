// Rate limits are skipped in other test files; this file switches them on before the app is loaded.
process.env.TEST_RATE_LIMITS = '1';

const { after, before, it } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { api, closeDatabase, resetDatabase } = await import('./helpers.js');

before(resetDatabase);
after(closeDatabase);

it('locks out repeated failed logins with 429', async () => {
  const attempt = () => api().post('/api/auth/login').send({ email: 'target@test.local', password: 'Wrong12345' });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).status, 401);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
});

it('limits public enquiry submissions', async () => {
  const send = () => api().post('/api/enquiries').send({ name: 'Spam', email: 'spam@example.com', message: 'hi' });
  for (let i = 0; i < 5; i += 1) assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 429);
});
