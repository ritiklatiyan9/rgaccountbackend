import 'dotenv/config';
import {
  DeleteMessageCommand, ReceiveMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import {
  PinpointSMSVoiceV2Client, SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import pool from '../config/db.js';
import { clientMessageQueueUrl, isClientMessageQueueConfigured } from '../services/clientMessagingQueue.service.js';

// Let the AWS SDK default credential chain handle workload roles, local
// profiles, environment credentials and temporary session tokens correctly.
const awsConfig = (region) => ({ region });

const queue = new SQSClient(awsConfig(process.env.AWS_MESSAGING_QUEUE_REGION || process.env.AWS_REGION || 'ap-south-1'));
const sms = new PinpointSMSVoiceV2Client(awsConfig(process.env.AWS_SMS_REGION || process.env.AWS_REGION || 'ap-south-1'));

const phoneE164 = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? `+${digits}` : null;
};
const permanentAwsError = (error) => [
  'AccessDeniedException', 'ValidationException', 'InvalidParameterException',
  'InvalidParametersException', 'ResourceNotFoundException', 'MessageRejected',
  'AccountSuspendedException',
].includes(error?.name);

async function sendSms(job) {
  const destination = phoneE164(job.destination);
  const origin = process.env.AWS_SMS_ORIGINATION_IDENTITY;
  if (!destination || !origin) throw Object.assign(new Error('Valid destination and AWS_SMS_ORIGINATION_IDENTITY are required'), { permanent: true });
  const country = {};
  if (process.env.AWS_SMS_ENTITY_ID) country.IN_ENTITY_ID = process.env.AWS_SMS_ENTITY_ID;
  if (process.env.AWS_SMS_TEMPLATE_ID) country.IN_TEMPLATE_ID = process.env.AWS_SMS_TEMPLATE_ID;
  const response = await sms.send(new SendTextMessageCommand({
    DestinationPhoneNumber: destination,
    OriginationIdentity: origin,
    MessageBody: job.message,
    MessageType: job.message_type === 'PROMOTIONAL' ? 'PROMOTIONAL' : 'TRANSACTIONAL',
    ...(Object.keys(country).length ? { DestinationCountryParameters: country } : {}),
    ...(process.env.AWS_SMS_CONFIGURATION_SET ? { ConfigurationSetName: process.env.AWS_SMS_CONFIGURATION_SET } : {}),
    ...(process.env.AWS_SMS_PROTECT_CONFIGURATION_ID ? { ProtectConfigurationId: process.env.AWS_SMS_PROTECT_CONFIGURATION_ID } : {}),
    Context: { campaign_id: String(job.campaign_id), delivery_id: String(job.delivery_id) },
  }));
  return response.MessageId;
}

const senders = { SMS: sendSms };

async function refreshCampaign(campaignId) {
  await pool.query(
    `WITH totals AS (
       SELECT COUNT(*) FILTER (WHERE status='SENT')::int AS sent,
              COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE status='SKIPPED')::int AS skipped,
              COUNT(*) FILTER (WHERE status IN ('QUEUED','SENDING'))::int AS pending
         FROM client_message_deliveries WHERE campaign_id=$1
     )
     UPDATE client_message_campaigns c
        SET sent_count=t.sent, failed_count=t.failed, skipped_count=t.skipped,
            status=CASE WHEN t.pending > 0 THEN 'SENDING'
                        WHEN t.failed = 0 THEN 'COMPLETED'
                        WHEN t.sent = 0 THEN 'FAILED' ELSE 'PARTIAL' END,
            updated_at=NOW()
       FROM totals t WHERE c.id=$1`,
    [campaignId]
  );
}

async function processMessage(message) {
  let job;
  try {
    job = JSON.parse(message.Body);
  } catch {
    return true;
  }
  if (!job?.delivery_id) return true;
  if (!senders[job.channel]) {
    await pool.query(
      `UPDATE client_message_deliveries
          SET status='FAILED', error='This delivery channel is no longer supported', updated_at=NOW()
        WHERE id=$1 AND status IN ('QUEUED','SENDING')`,
      [job.delivery_id]
    );
    if (job.campaign_id) await refreshCampaign(job.campaign_id);
    return true;
  }

  const claim = await pool.query(
    `UPDATE client_message_deliveries
        SET status='SENDING', attempt_count=attempt_count+1, error=NULL, updated_at=NOW()
      WHERE id=$1 AND campaign_id=$2 AND status='QUEUED'
      RETURNING id, campaign_id`,
    [job.delivery_id, job.campaign_id]
  );
  if (!claim.rows[0]) {
    // SENT/FAILED means an old duplicate queue message. SENDING means the
    // previous worker may have handed it to AWS; do not risk a duplicate send.
    const current = await pool.query('SELECT status FROM client_message_deliveries WHERE id=$1', [job.delivery_id]);
    if (current.rows[0]?.status === 'SENDING') {
      await pool.query(
        `UPDATE client_message_deliveries SET status='FAILED', error='Delivery state was uncertain after worker interruption', updated_at=NOW() WHERE id=$1`,
        [job.delivery_id]
      );
      await refreshCampaign(job.campaign_id);
    }
    return true;
  }

  try {
    const providerId = await senders[job.channel](job);
    await pool.query(
      `UPDATE client_message_deliveries
          SET status='SENT', provider_message_id=$1, sent_at=NOW(), updated_at=NOW()
        WHERE id=$2`,
      [providerId || null, job.delivery_id]
    );
    await refreshCampaign(job.campaign_id);
    return true;
  } catch (error) {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount || 1);
    const permanent = error.permanent || permanentAwsError(error) || receiveCount >= 5;
    await pool.query(
      `UPDATE client_message_deliveries
          SET status=$1, error=$2, updated_at=NOW()
        WHERE id=$3`,
      [permanent ? 'FAILED' : 'QUEUED', String(error?.message || error).slice(0, 1000), job.delivery_id]
    );
    await refreshCampaign(job.campaign_id);
    return permanent;
  }
}

async function poll() {
  const response = await queue.send(new ReceiveMessageCommand({
    QueueUrl: clientMessageQueueUrl(),
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20,
    VisibilityTimeout: 60,
    AttributeNames: ['ApproximateReceiveCount'],
  }));
  for (const message of response.Messages || []) {
    if (await processMessage(message)) {
      await queue.send(new DeleteMessageCommand({ QueueUrl: clientMessageQueueUrl(), ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

async function main() {
  if (!isClientMessageQueueConfigured()) {
    console.error('[client-messages] AWS_CLIENT_MESSAGE_QUEUE_URL is not configured');
    process.exit(1);
  }
  console.log('[client-messages] worker started');
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    try {
      await poll();
    } catch (error) {
      console.error('[client-messages] poll failed:', error?.message || error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await pool.end();
}

main().catch((error) => {
  console.error('[client-messages] fatal:', error);
  process.exitCode = 1;
});
