import { env } from '../../../config/env.js';
import { withTransaction } from '../../../config/db.js';
import { send } from '../../../utils/http.js';
import { logActivity } from '../../../services/activity.service.js';
import { isEmailConfigured } from '../../../services/email.service.js';
import { getCompletionPolicy, getFeeSettings, saveCompletionPolicy, saveFeeSettings } from '../../../services/settings.service.js';

export async function get(_req, res) {
  const [completionPolicy, fees] = await Promise.all([getCompletionPolicy(), getFeeSettings()]);
  send(res, {
    completionPolicy,
    fees,
    email: { configured: isEmailConfigured(), enquiryRecipients: env.smtp.enquiryRecipients.length },
  });
}

export async function updateCompletionPolicy(req, res) {
  const policy = await withTransaction(async (db) => {
    const saved = await saveCompletionPolicy(req.valid.body, req.user.id, db);
    await logActivity(
      {
        actorId: req.user.id,
        action: 'settings.completion_policy_updated',
        entityType: 'setting',
        description: 'Course completion policy updated',
        metadata: saved,
      },
      db,
    );
    return saved;
  });
  send(res, { completionPolicy: policy });
}

export async function updateFeeSettings(req, res) {
  const fees = await withTransaction(async (db) => {
    const saved = await saveFeeSettings(req.valid.body, req.user.id, db);
    await logActivity(
      {
        actorId: req.user.id,
        action: 'settings.fees_updated',
        entityType: 'setting',
        description: 'Fee and payment settings updated',
        metadata: { currency: saved.currency },
      },
      db,
    );
    return saved;
  });
  send(res, { fees });
}
