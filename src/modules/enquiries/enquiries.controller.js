import { clientIp, created, send, sendPage } from '../../utils/http.js';
import * as service from './enquiries.service.js';

// ─── Public (website contact form) ──────────────────────────────────────

export async function submit(req, res) {
  const { enquiry } = await service.submitWebsiteEnquiry(req.valid.body, clientIp(req));
  created(res, { id: enquiry.id, message: 'Thank you! Your enquiry has been received. Our team will contact you soon.' });
}

// ─── Admin ──────────────────────────────────────────────────────────────

export async function list(req, res) {
  sendPage(res, await service.listEnquiries(req.valid.query), req.valid.query);
}

export async function counts(_req, res) {
  send(res, await service.enquiryStatusCounts());
}

export async function get(req, res) {
  send(res, await service.getEnquiry(req.valid.params.enquiryId));
}

export async function create(req, res) {
  created(res, await service.createManualEnquiry(req.valid.body, req.user));
}

export async function update(req, res) {
  send(res, await service.updateEnquiry(req.valid.params.enquiryId, req.valid.body, req.user));
}

export async function addNote(req, res) {
  created(res, await service.addNote(req.valid.params.enquiryId, req.valid.body.note, req.user));
}

export async function retryNotification(req, res) {
  send(res, await service.retryNotification(req.valid.params.enquiryId));
}
