import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { creditedSeconds, summarizeProgress } from '../src/services/progress.service.js';
import { toCsv } from '../src/utils/csv.js';
import { camelize } from '../src/utils/http.js';
import { escapeLike, orderBy } from '../src/utils/sql.js';

describe('video watch-time crediting', () => {
  it('credits normal playback', () => {
    assert.equal(creditedSeconds({ previousPosition: 20, newPosition: 30, secondsSinceLastHeartbeat: 10 }), 10);
  });
  it('allows up to 2× playback speed', () => {
    assert.equal(creditedSeconds({ previousPosition: 0, newPosition: 20, secondsSinceLastHeartbeat: 10 }), 20);
  });
  it('ignores seeking forward', () => {
    assert.equal(creditedSeconds({ previousPosition: 10, newPosition: 300, secondsSinceLastHeartbeat: 10 }), 0);
  });
  it('ignores rewinding', () => {
    assert.equal(creditedSeconds({ previousPosition: 100, newPosition: 40, secondsSinceLastHeartbeat: 10 }), 0);
  });
  it('caps credit after long pauses so idle time cannot be cashed in', () => {
    assert.equal(creditedSeconds({ previousPosition: 0, newPosition: 3000, secondsSinceLastHeartbeat: 3600 }), 0);
  });
});

describe('progress summary', () => {
  const counts = { videos_total: 4, videos_done: 2, assignments_total: 2, assignments_done: 1 };
  const policy = { requireAllVideos: true, requireAllAssignments: true };

  it('combines enabled requirements', () => {
    const p = summarizeProgress(counts, policy, 'active');
    assert.equal(p.percent, 50);
    assert.equal(p.criteria_met, false);
  });
  it('ignores disabled requirements', () => {
    const p = summarizeProgress({ ...counts, videos_done: 4 }, { ...policy, requireAllAssignments: false }, 'active');
    assert.equal(p.percent, 100);
    assert.equal(p.criteria_met, true);
  });
  it('treats a course without requirements as not completable', () => {
    const p = summarizeProgress({ videos_total: 0, videos_done: 0, assignments_total: 0, assignments_done: 0 }, policy, 'active');
    assert.equal(p.criteria_met, false);
    assert.equal(p.percent, 0);
  });
  it('keeps completed enrolments at 100%', () => {
    assert.equal(summarizeProgress(counts, policy, 'completed').percent, 100);
  });
});

describe('utilities', () => {
  it('neutralises spreadsheet formulas and quotes CSV cells', () => {
    const csv = toCsv(
      [{ a: '=HYPERLINK("x")', b: 'Doe, John' }],
      [
        { header: 'A', value: (r) => r.a },
        { header: 'B', value: (r) => r.b },
      ],
    );
    assert.equal(csv, 'A,B\r\n"\'=HYPERLINK(""x"")","Doe, John"');
  });
  it('escapes LIKE wildcards', () => {
    assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  });
  it('only sorts by whitelisted columns', () => {
    assert.equal(orderBy('name; DROP TABLE users', 'asc', { name: 'u.full_name' }, 'name'), 'ORDER BY u.full_name ASC NULLS LAST');
  });
  it('camelizes nested rows without touching dates', () => {
    const date = new Date();
    assert.deepEqual(camelize({ full_name: 'A', nested_list: [{ created_at: date }] }), {
      fullName: 'A',
      nestedList: [{ createdAt: date }],
    });
  });
});
