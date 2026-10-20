import { created, send, sendPage } from '../../utils/http.js';
import * as service from './meetings.service.js';

// Professor (organiser of their own meetings)

export async function professorList(req, res) {
  sendPage(res, await service.listMeetings(req.user.id, req.valid.query), req.valid.query);
}

export async function professorGet(req, res) {
  send(res, await service.getMeeting(req.valid.params.meetingId, { professorId: req.user.id }));
}

export async function batchStudents(req, res) {
  send(res, await service.batchStudents(req.user.id, req.valid.params.batchId));
}

// E-mails are sent after the response; their outcomes are visible on the meeting (recipients[].emailStatus).
export async function create(req, res) {
  created(res, (await service.createMeeting(req.user, req.valid.body)).meeting);
}

export async function update(req, res) {
  send(res, (await service.updateMeeting(req.user, req.valid.params.meetingId, req.valid.body)).meeting);
}

export async function cancel(req, res) {
  send(res, (await service.cancelMeeting(req.user, req.valid.params.meetingId, req.valid.body.reason)).meeting);
}

export async function resend(req, res) {
  send(res, await service.resendEmails(req.user, req.valid.params.meetingId));
}

// Student (meetings of their batch, or shared with them)

export async function studentList(req, res) {
  send(res, await service.studentMeetings(req.user.id, req.valid.query.when));
}

// Admin (read-only monitoring)

export async function adminList(req, res) {
  sendPage(res, await service.adminListMeetings(req.valid.query), req.valid.query);
}

export async function adminGet(req, res) {
  send(res, await service.getMeeting(req.valid.params.meetingId));
}
