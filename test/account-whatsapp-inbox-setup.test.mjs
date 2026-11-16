import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWhatsAppResourcePolicy, whatsappTopicPublishStatement, whatsappQueueDeliveryStatement, setupAccountWhatsAppInbox } from '../scripts/setup-account-whatsapp-inbox.mjs';
const topic = 'arn:aws:sns:ap-south-1:123456789012:incoming';
const queue = 'arn:aws:sqs:ap-south-1:123456789012:inbox';
const sender = 'arn:aws:social-messaging:ap-south-1:123456789012:waba/example';

test('incoming topic permission is limited to the Social Messaging service in the sender account', () => {
  const statement = whatsappTopicPublishStatement(topic, sender);
  assert.deepEqual(statement.Principal, { Service: 'social-messaging.amazonaws.com' });
  assert.equal(statement.Resource, topic);
  assert.equal(statement.Condition.StringEquals['aws:SourceAccount'], '123456789012');
  assert.equal(statement.Condition.ArnLike['aws:SourceArn'], 'arn:aws:social-messaging:ap-south-1:123456789012:*');
  assert.throws(() => whatsappTopicPublishStatement(topic.replace('123456789012','999999999999'), sender), /same AWS account/);
});

test('private reply queue accepts messages only from its bound SNS topic and retains other existing statements', () => {
  const statement = whatsappQueueDeliveryStatement(queue, topic);
  assert.deepEqual(statement.Principal, { Service: 'sns.amazonaws.com' });
  assert.equal(statement.Action, 'sqs:SendMessage');
  assert.equal(statement.Condition.ArnEquals['aws:SourceArn'], topic);
  const previous = { Sid: 'OtherExistingApplication', Effect: 'Allow', Principal: { AWS: '123456789012' }, Action: 'sqs:GetQueueAttributes', Resource: queue };
  const policy = JSON.parse(mergeWhatsAppResourcePolicy(JSON.stringify({ Version: '2012-10-17', Statement: [previous, statement] }), statement));
  assert.deepEqual(policy.Statement[0], previous);
  assert.equal(policy.Statement.filter(row => row.Sid === statement.Sid).length, 1);
});

test('inbox infrastructure cannot be provisioned by importing or without explicit apply', async () => {
  await assert.rejects(setupAccountWhatsAppInbox({ organizationId: 1 }), /--apply/);
});
