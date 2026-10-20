import { withTransaction } from '../config/db.js';

/**
 * Turn the raw counts from the `enrolment_progress` view into the progress shown to users.
 * Only requirements enabled in the completion policy count towards the percentage.
 */
export function summarizeProgress(counts, policy, enrolmentStatus) {
  const parts = [];
  if (policy.requireAllVideos) parts.push({ total: counts.videos_total, done: counts.videos_done });
  if (policy.requireAllAssignments) parts.push({ total: counts.assignments_total, done: counts.assignments_done });
  const total = parts.reduce((s, p) => s + p.total, 0);
  const done = parts.reduce((s, p) => s + Math.min(p.done, p.total), 0);
  const criteriaMet = total > 0 && parts.every((p) => p.done >= p.total);
  return {
    videos_total: counts.videos_total,
    videos_done: counts.videos_done,
    assignments_total: counts.assignments_total,
    assignments_done: counts.assignments_done,
    requires_videos: policy.requireAllVideos,
    requires_assignments: policy.requireAllAssignments,
    items_total: total,
    items_done: done,
    // A completed enrolment stays at 100% even if content is added later.
    percent: enrolmentStatus === 'completed' ? 100 : total ? Math.floor((done * 100) / total) : 0,
    criteria_met: criteriaMet,
  };
}

/** Attach a `progress` object to rows that carry the four view counts and `status` (enrolment status). */
export const attachProgress = (rows, policy) =>
  rows.map(({ videos_total, videos_done, assignments_total, assignments_done, ...row }) => ({
    ...row,
    progress: summarizeProgress({ videos_total, videos_done, assignments_total, assignments_done }, policy, row.status),
  }));

// Heartbeats arrive every ~10 s while playing. A single heartbeat can credit at most
// MAX_ELAPSED_CREDIT × MAX_PLAYBACK_RATE + JITTER seconds, so seeking to the end earns nothing.
const MAX_ELAPSED_CREDIT = 30;
const MAX_PLAYBACK_RATE = 2;
const JITTER_SECONDS = 5;

/** Pure crediting rule, exported for unit tests. */
export function creditedSeconds({ previousPosition, newPosition, secondsSinceLastHeartbeat }) {
  const elapsed = Math.min(secondsSinceLastHeartbeat ?? MAX_ELAPSED_CREDIT, MAX_ELAPSED_CREDIT);
  const delta = newPosition - previousPosition;
  return delta > 0 && delta <= elapsed * MAX_PLAYBACK_RATE + JITTER_SECONDS ? delta : 0;
}

/**
 * Record a playback heartbeat for (student, video). Returns the updated progress and whether
 * the video crossed the completion threshold with this heartbeat.
 */
export async function recordVideoHeartbeat({ studentId, video, position, thresholdPercent }) {
  return withTransaction(async (db) => {
    await db.query('INSERT INTO video_progress (video_id, student_id) VALUES ($1, $2) ON CONFLICT (video_id, student_id) DO NOTHING', [
      video.id,
      studentId,
    ]);
    const { rows } = await db.query('SELECT * FROM video_progress WHERE video_id = $1 AND student_id = $2 FOR UPDATE', [
      video.id,
      studentId,
    ]);
    const current = rows[0];
    const duration = video.duration_seconds;
    const newPosition = Math.min(Math.max(position, 0), duration);
    const credit = creditedSeconds({
      previousPosition: current.last_position,
      newPosition,
      secondsSinceLastHeartbeat: current.last_heartbeat_at ? (Date.now() - current.last_heartbeat_at.getTime()) / 1000 : null,
    });
    const watched = Math.min(duration, current.watched_seconds + credit);
    const reached = watched >= (duration * thresholdPercent) / 100;
    const justCompleted = !current.completed_at && reached;

    const { rows: updated } = await db.query(
      `UPDATE video_progress
          SET watched_seconds = $2, last_position = $3, last_heartbeat_at = now(),
              completed_at = COALESCE(completed_at, CASE WHEN $4::boolean THEN now() END)
        WHERE id = $1
        RETURNING watched_seconds, last_position, completed_at`,
      [current.id, watched, newPosition, reached],
    );
    return { ...updated[0], just_completed: justCompleted };
  });
}

/**
 * Progress summary per group (e.g. per batch) of enrolment rows that carry the view counts and `status`:
 * `{ [key]: { enrolments, completed, averagePercent } }`, with the completion policy applied.
 */
export function progressByGroup(rows, policy, key) {
  const groups = {};
  for (const row of attachProgress(rows, policy)) {
    const g = (groups[row[key]] ??= { enrolments: 0, completed: 0, percentSum: 0 });
    g.enrolments += 1;
    g.completed += row.status === 'completed' ? 1 : 0;
    g.percentSum += row.progress.percent;
  }
  return Object.fromEntries(
    Object.entries(groups).map(([k, g]) => [
      k,
      { enrolments: g.enrolments, completed: g.completed, average_percent: Math.round(g.percentSum / g.enrolments) },
    ]),
  );
}
