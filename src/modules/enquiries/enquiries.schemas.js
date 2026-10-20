import { z } from 'zod';
import { email, id, isoDate, listQuery, optionalText, phone, requiredText } from '../../validators/common.js';

export const ENQUIRY_STATUSES = ['new', 'contacted', 'follow_up', 'converted', 'closed'];

export const enquirySchema = z.object({
  name: requiredText(120, 'Name'),
  email,
  phone,
  subject: optionalText(200),
  message: requiredText(5000, 'Message'),
  courseInterest: optionalText(200),
});

export const listEnquiriesQuery = listQuery(['created_at', 'status', 'name', 'follow_up_on'], {
  status: z.enum(ENQUIRY_STATUSES).optional(),
  source: z.enum(['website', 'admin']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const updateEnquirySchema = z
  .object({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    followUpOn: isoDate.nullish(),
  })
  .refine((v) => v.status !== undefined || v.followUpOn !== undefined, { message: 'Nothing to update' });

export const noteSchema = z.object({ note: requiredText(5000, 'Note') });
export const enquiryIdParams = z.object({ enquiryId: id });
