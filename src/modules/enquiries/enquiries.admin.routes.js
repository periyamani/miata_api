import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './enquiries.controller.js';
import * as s from './enquiries.schemas.js';

const router = Router();

router.get('/enquiries', validate({ query: s.listEnquiriesQuery }), ctrl.list);
router.get('/enquiries/counts', ctrl.counts);
router.post('/enquiries', validate({ body: s.enquirySchema }), ctrl.create);
router.get('/enquiries/:enquiryId', validate({ params: s.enquiryIdParams }), ctrl.get);
router.patch('/enquiries/:enquiryId', validate({ params: s.enquiryIdParams, body: s.updateEnquirySchema }), ctrl.update);
router.post('/enquiries/:enquiryId/notes', validate({ params: s.enquiryIdParams, body: s.noteSchema }), ctrl.addNote);
router.post('/enquiries/:enquiryId/notify', validate({ params: s.enquiryIdParams }), ctrl.retryNotification);

export default router;
