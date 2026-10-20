// Creates/updates the MOCK database (MOCK_DB_NAME) and loads database/mock-data into it.
//   npm run db:mock              first load (the mock database must be empty)
//   npm run db:mock -- --reset   drop the mock schema and reload from the files
//   npm run db:seed              same as db:mock
// The live database (LIVE_DB_NAME) is never touched.
import { env } from '../src/config/env.js';
import { loadMockData } from './lib/mockData.js';

const database = env.databases.mock;

try {
  console.log(`Loading mock data into "${database}" …`);
  const counts = await loadMockData({
    database,
    uploadDir: env.uploadDirs.mock,
    reset: process.argv.includes('--reset'),
    log: console.log,
  });
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(30)} ${n}`);
  console.log('Done. Start the API on mock data with: npm run dev:mock');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
