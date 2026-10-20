// Runs the test suite against the mock database (MOCK_DB_NAME), then reloads database/mock-data so the mock database is
// ready for development again — the tests rebuild its schema and wipe MOCK_UPLOAD_DIR. The live database is never touched.
//   npm test
import { spawnSync } from 'node:child_process';
import { API_ROOT, env } from '../src/config/env.js';
import { loadMockData } from './lib/mockData.js';

const { status } = spawnSync(
  process.execPath,
  ['--import', './tests/setup-env.js', '--test', '--test-reporter=spec', '--test-concurrency=1', 'tests/**/*.test.js'],
  { cwd: API_ROOT, stdio: 'inherit' },
);

try {
  console.log(`\nReloading the mock data into "${env.databases.mock}" …`);
  await loadMockData({ database: env.databases.mock, uploadDir: env.uploadDirs.mock, reset: true });
  console.log('Mock data restored.');
} catch (err) {
  console.error(`Could not reload the mock data: ${err.message}. Run: npm run db:mock -- --reset`);
  process.exitCode = 1;
}
if (status !== 0) process.exitCode = status ?? 1;
