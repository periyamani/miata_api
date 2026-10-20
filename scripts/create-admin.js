// Creates an Admin account. Admins cannot be created through the API or the portal.
//
//   npm run create-admin                      interactive (recommended — the password is typed hidden)
//   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run create-admin -- --non-interactive   (automation)
import readline from 'node:readline';
import { z } from 'zod';
import { env } from '../src/config/env.js';
import { pool, withTransaction } from '../src/config/db.js';
import { logActivity } from '../src/services/activity.service.js';
import { createAccount } from '../src/modules/users/user.repository.js';
import { email as emailSchema, password as passwordSchema } from '../src/validators/common.js';

function prompt(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(s);
      else if (s !== '\r\n' && s !== '\n') rl.output.write('*'.repeat(s.length));
      else rl.output.write(s);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    }),
  );
}

function check(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0].message);
  return result.data;
}

async function collectInput() {
  if (process.argv.includes('--non-interactive')) {
    return {
      fullName: check(z.string().trim().min(2, 'ADMIN_NAME is required'), process.env.ADMIN_NAME ?? ''),
      email: check(emailSchema, process.env.ADMIN_EMAIL ?? ''),
      password: check(passwordSchema, process.env.ADMIN_PASSWORD ?? ''),
    };
  }
  console.log('Create a MIATA administrator\n');
  const fullName = check(z.string().trim().min(2, 'Name must be at least 2 characters'), await prompt('Full name: '));
  const email = check(emailSchema, await prompt('Email: '));
  const password = check(passwordSchema, await prompt('Password (min 8 chars, letters + numbers): ', { hidden: true }));
  if ((await prompt('Confirm password: ', { hidden: true })) !== password) throw new Error('Passwords do not match');
  return { fullName, email, password };
}

try {
  const input = await collectInput();
  const user = await withTransaction(async (db) => {
    const created = await createAccount({ role: 'admin', ...input }, db);
    await logActivity(
      {
        action: 'admin.created',
        entityType: 'user',
        entityId: created.id,
        description: `Admin account created for ${created.email} (CLI)`,
      },
      db,
    );
    return created;
  });
  console.log(`\nAdmin account created: ${user.email} (id ${user.id}). Sign in at ${env.frontendUrl}/login/admin`);
} catch (err) {
  console.error(`\nCould not create admin: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
