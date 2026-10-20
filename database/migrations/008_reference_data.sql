-- 008 · Reference data every database needs (live and mock). This is configuration, not sample data:
-- mock data lives separately in database/mock-data/ and is never loaded into the live database.

INSERT INTO app_settings (key, value) VALUES (
  'completion_policy',
  '{
    "requireAllVideos": true,
    "requireAllAssignments": true,
    "videoWatchThreshold": 90,
    "logoutOnCompletion": true,
    "passwordResetOnCompletion": "next_login"
  }'::jsonb
);
