import { Router } from 'express';
import { enquiryLimiter } from '../../middleware/rateLimiters.js';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './enquiries.controller.js';
import { enquirySchema } from './enquiries.schemas.js';

// Public endpoint used by the website contact form (miata-web ContactFormSection).
const router = Router();

router.post('/', enquiryLimiter, validate({ body: enquirySchema }), ctrl.submit);

export default router;
