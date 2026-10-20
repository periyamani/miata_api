import { Router } from 'express';
import { uploadSingle } from '../../../middleware/upload.js';
import { validate } from '../../../middleware/validate.js';
import * as ctrl from './videos.controller.js';
import * as s from './videos.schemas.js';

const router = Router();

router.get('/videos', validate({ query: s.listVideosQuery }), ctrl.list);
router.post('/videos', uploadSingle('video', 'video'), validate({ body: s.uploadVideoSchema }), ctrl.upload);
router.get('/videos/:videoId', validate({ params: s.videoIdParams }), ctrl.get);
router.put('/videos/:videoId', validate({ params: s.videoIdParams, body: s.updateVideoSchema }), ctrl.update);
router.patch('/videos/:videoId/publish', validate({ params: s.videoIdParams, body: s.publishSchema }), ctrl.setPublished);
router.delete('/videos/:videoId', validate({ params: s.videoIdParams }), ctrl.remove);
router.get('/videos/:videoId/access', validate({ params: s.videoIdParams }), ctrl.access);

export default router;
