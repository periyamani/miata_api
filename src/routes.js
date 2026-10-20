import { Router } from 'express';
import { checkConnection } from './config/db.js';
import { send } from './utils/http.js';
import { authenticate, authorize } from './middleware/authenticate.js';
import authRoutes from './modules/auth/auth.routes.js';
import profileRoutes from './modules/profile/profile.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import publicEnquiryRoutes from './modules/enquiries/enquiries.public.routes.js';
import mediaRoutes from './modules/media/media.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import agentRoutes from './modules/agent/agent.routes.js';
import professorRoutes from './modules/professor/professor.routes.js';
import studentRoutes from './modules/student/student.routes.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const db = await checkConnection();
  send(res, { status: 'ok', database: db.db });
});

router.use('/auth', authRoutes);
router.use('/enquiries', publicEnquiryRoutes);
router.use('/media', mediaRoutes);
router.use('/profile', profileRoutes);
router.use('/notifications', notificationRoutes);

// Role namespaces: the guard here is the first line of defence; services scope every query to the caller.
router.use('/admin', authenticate, authorize('admin'), adminRoutes);
router.use('/agent', authenticate, authorize('agent'), agentRoutes);
router.use('/professor', authenticate, authorize('professor'), professorRoutes);
router.use('/student', authenticate, authorize('student'), studentRoutes);

export default router;
