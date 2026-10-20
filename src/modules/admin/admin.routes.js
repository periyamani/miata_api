import { Router } from 'express';
import dashboardRoutes from './dashboard/dashboard.routes.js';
import lookupRoutes from './lookups/lookups.routes.js';
import courseRoutes from './courses/courses.routes.js';
import batchRoutes from './batches/batches.routes.js';
import enrolmentRoutes from './enrolments/enrolments.routes.js';
import paymentRoutes from './payments/payments.routes.js';
import teachingRoutes from './teaching/teaching.routes.js';
import studentRoutes from './students/students.routes.js';
import professorRoutes from './professors/professors.routes.js';
import agentRoutes from './agents/agents.routes.js';
import referralRoutes from './referrals/referrals.routes.js';
import assignmentRoutes from './assignments/assignments.routes.js';
import videoRoutes from './videos/videos.routes.js';
import enquiryRoutes from '../enquiries/enquiries.admin.routes.js';
import settingsRoutes from './settings/settings.routes.js';
import activityRoutes from './activity/activity.routes.js';
import { adminMeetingRoutes } from '../meetings/meetings.routes.js';

// Mounted at /api/admin behind authenticate + authorize('admin').
const router = Router();

for (const routes of [
  dashboardRoutes,
  lookupRoutes,
  courseRoutes,
  batchRoutes,
  enrolmentRoutes,
  paymentRoutes,
  teachingRoutes,
  studentRoutes,
  professorRoutes,
  agentRoutes,
  referralRoutes,
  assignmentRoutes,
  adminMeetingRoutes,
  videoRoutes,
  enquiryRoutes,
  settingsRoutes,
  activityRoutes,
]) {
  router.use(routes);
}

export default router;
