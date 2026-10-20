import { assertSessionUsable, loadSessionUser } from '../../middleware/authenticate.js';
import { verifyMediaToken } from '../../services/token.service.js';
import { getAccessibleVideo } from '../../services/videoAccess.service.js';
import { sendStoredFile } from '../../services/storage.service.js';
import { forbidden, unauthorized } from '../../utils/AppError.js';

/**
 * Stream a video. Authenticated by the signed `token` query parameter (a <video> element cannot send
 * headers). The token is bound to one video and user, and the user's access is re-checked on every request.
 */
export async function streamVideo(req, res) {
  const { videoId } = req.valid.params;
  let payload;
  try {
    payload = verifyMediaToken(req.valid.query.token);
  } catch {
    throw unauthorized('This video link has expired. Reload the page to continue.', 'MEDIA_TOKEN_INVALID');
  }
  if (Number(payload.vid) !== videoId) throw forbidden();

  const user = await loadSessionUser(Number(payload.sub));
  assertSessionUsable(user, payload.tv);
  const video = await getAccessibleVideo(user, videoId);
  // miata-web may be hosted on another origin; the signed token, not the origin, protects the stream.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  await sendStoredFile(res, video, { inline: true });
}
