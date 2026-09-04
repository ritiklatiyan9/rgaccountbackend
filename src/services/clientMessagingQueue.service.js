import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

const config = {
  region: process.env.AWS_MESSAGING_QUEUE_REGION || process.env.AWS_REGION || 'ap-south-1',
};

let client;
const sqs = () => (client ||= new SQSClient(config));

export const clientMessageQueueUrl = () => process.env.AWS_CLIENT_MESSAGE_QUEUE_URL || '';
export const isClientMessageQueueConfigured = () => Boolean(clientMessageQueueUrl());

/** Queue delivery jobs in SQS's maximum batch size. The index in failures
 * always points back to the original jobs array. */
export async function enqueueClientMessages(jobs) {
  if (!jobs.length) return { queued: 0, failed: [] };
  if (!isClientMessageQueueConfigured()) {
    return { queued: 0, failed: jobs.map((_, index) => ({ index, error: 'AWS_CLIENT_MESSAGE_QUEUE_URL is not configured' })) };
  }

  let queued = 0;
  const failed = [];
  for (let start = 0; start < jobs.length; start += 10) {
    const chunk = jobs.slice(start, start + 10);
    try {
      const response = await sqs().send(new SendMessageBatchCommand({
        QueueUrl: clientMessageQueueUrl(),
        Entries: chunk.map((job, offset) => ({
          Id: String(offset),
          MessageBody: JSON.stringify(job),
        })),
      }));
      queued += response.Successful?.length || 0;
      for (const failure of response.Failed || []) {
        failed.push({ index: start + Number(failure.Id), error: failure.Message || failure.Code || 'SQS rejected the message' });
      }
    } catch (error) {
      for (let offset = 0; offset < chunk.length; offset++) {
        failed.push({ index: start + offset, error: error?.message || String(error) });
      }
    }
  }
  return { queued, failed };
}
