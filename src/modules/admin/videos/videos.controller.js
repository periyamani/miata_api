import { created, send, sendPage } from '../../../utils/http.js';
import * as service from './videos.service.js';

export async function list(req, res) {
  sendPage(res, await service.listVideos(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getVideo(req.valid.params.videoId));
}

export async function upload(req, res) {
  created(res, await service.uploadVideo(req.valid.body, req.file, req.user));
}

export async function update(req, res) {
  send(res, await service.updateVideo(req.valid.params.videoId, req.valid.body, req.user));
}

export async function setPublished(req, res) {
  send(res, await service.setPublished(req.valid.params.videoId, req.valid.body.isPublished, req.user));
}

export async function remove(req, res) {
  await service.deleteVideo(req.valid.params.videoId, req.user);
  send(res, { deleted: true });
}

export async function access(req, res) {
  send(res, await service.previewUrl(req.valid.params.videoId, req.user));
}
