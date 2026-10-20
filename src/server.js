import { env } from './config/env.js';
import { checkConnection, pool } from './config/db.js';
import { pendingMigrations } from './config/migrator.js';
import { createApp } from './app.js';
import { ensureUploadDirs } from './services/storage.service.js';
import { verifyEmailTransport } from './services/email.service.js';
import { startAccessExpiryJob } from './services/accessExpiry.service.js';
import { logger } from './utils/logger.js';

const SETUP_HINT = { live: 'npm run db:setup', mock: 'npm run db:mock' };

async function start() {
  if (env.isProduction && env.dataSource === 'mock') {
    logger.error('Mock data is for development and testing only. Remove --mock / DATA_SOURCE=mock in production.');
    process.exit(1);
  }

  try {
    const db = await checkConnection();
    logger.info(`Connected to PostgreSQL database "${db.db}" (${env.dataSource} data)`);
  } catch (err) {
    logger.error(`Cannot connect to PostgreSQL at ${env.db.host}:${env.db.port}/${env.db.database}: ${err.message}`);
    logger.error(
      `Check the DB_* values in miata-api/.env, that PostgreSQL is running, and that the database exists (${SETUP_HINT[env.dataSource]}).`,
    );
    process.exit(1);
  }

  const pending = await pendingMigrations();
  if (pending.length) {
    logger.error(`Database schema is out of date (${pending.join(', ')} not applied). Run: ${SETUP_HINT[env.dataSource]}`);
    process.exit(1);
  }

  await ensureUploadDirs();
  verifyEmailTransport();

  const server = createApp().listen(env.port, () => {
    logger.info(`MIATA API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });
  // Deactivates students whose course access period has ended (see services/accessExpiry.service.js).
  const stopAccessExpiryJob = startAccessExpiryJob();

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    stopAccessExpiryJob();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
