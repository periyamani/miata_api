import { AppError } from '../../utils/AppError.js';
import { clientIp, send } from '../../utils/http.js';
import { formatIssues } from '../../middleware/validate.js';
import { selfProfileSchemas } from './profile.schemas.js';
import * as profileService from './profile.service.js';

export async function getProfile(req, res) {
  send(res, await profileService.getOwnProfile(req.user.id));
}

export async function updateProfile(req, res) {
  // The allowed fields depend on the caller's role, so validation happens here rather than in the route.
  const result = selfProfileSchemas[req.user.role].safeParse(req.body ?? {});
  if (!result.success) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', formatIssues(result.error.issues));
  }
  send(res, await profileService.updateOwnProfile(req.user, result.data, clientIp(req)));
}
