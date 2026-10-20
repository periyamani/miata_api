import { send } from '../../../utils/http.js';
import { listBatches } from '../batches/batches.service.js';
import * as repo from './dashboard.repository.js';

export async function overview(req, res) {
  const [stats, monthly, completion, courses, batches, enquiries, activity] = await Promise.all([
    repo.stats(),
    repo.monthlyOverview(req.valid.query.months),
    repo.completionBreakdown(),
    repo.coursesOverview(),
    listBatches({ page: 1, pageSize: 6, status: 'active', sort: 'start_date', order: 'desc' }),
    repo.recentEnquiries(),
    repo.recentActivity(),
  ]);
  send(res, { stats, monthly, completion, courses, batches: batches.rows, recentEnquiries: enquiries, recentActivity: activity });
}
