import { z } from 'zod';
import { id, listQuery } from './common.js';

export const REFERRAL_STATUSES = ['active', 'pending', 'completed', 'inactive'];

const filters = {
  status: z.enum(REFERRAL_STATUSES).optional(),
  courseId: id.optional(),
};

export const referralListSchema = listQuery(['full_name', 'registered_at', 'status', 'agent', 'student_code'], filters);

export const referralExportSchema = z.object({
  ...filters,
  search: z.string().trim().max(100).optional(),
  agentId: id.optional(),
});
