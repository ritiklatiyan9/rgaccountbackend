// Explicit operator setup only. No customer messages or templates are sent here.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SNSClient, CreateTopicCommand, GetTopicAttributesCommand, SetTopicAttributesCommand, SubscribeCommand, ListSubscriptionsByTopicCommand, SetSubscriptionAttributesCommand } from '@aws-sdk/client-sns';
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SocialMessagingClient, GetLinkedWhatsAppBusinessAccountPhoneNumberCommand, GetLinkedWhatsAppBusinessAccountCommand, PutWhatsAppBusinessAccountEventDestinationsCommand } from '@aws-sdk/client-socialmessaging';
import { loadSharedWhatsAppSender } from './account-whatsapp-preview.mjs';

export function mergeWhatsAppResourcePolicy(existing, statement) {
  const policy = existing ? JSON.parse(existing) : { Version: '2012-10-17', Statement: [] };
  const statements = Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : [];
  return JSON.stringify({ ...policy, Version: '2012-10-17', Statement: [...statements.filter(item => item.Sid !== statement.Sid), statement] });
}

export function whatsappTopicPublishStatement(topicArn, sourceArn) {
  const [, partition, , region, accountId] = sourceArn.split(':');
  if (!/^\d{12}$/.test(accountId || '') || !topicArn.startsWith(`arn:${partition}:sns:${region}:${accountId}:`)) throw new Error('Sender and incoming topic must belong to the same AWS account and region.');
  return {
    Sid: 'AccountWhatsAppSocialPublish', Effect: 'Allow',
    Principal: { Service: 'social-messaging.amazonaws.com' }, Action: 'sns:Publish', Resource: topicArn,
    Condition: { StringEquals: { 'aws:SourceAccount': accountId }, ArnLike: { 'aws:SourceArn': `arn:${partition}:social-messaging:${region}:${accountId}:*` } },
  };
}

export function whatsappQueueDeliveryStatement(queueArn, topicArn) {
  const accountId = topicArn.split(':')[4];
  if (!/^\d{12}$/.test(accountId || '') || queueArn.split(':')[4] !== accountId) throw new Error('Incoming queue and topic must belong to the same AWS account.');
  return {
    Sid: 'AccountWhatsAppSnsDelivery', Effect: 'Allow',
    Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn,
    Condition: { ArnEquals: { 'aws:SourceArn': topicArn }, StringEquals: { 'aws:SourceAccount': accountId } },
  };
}

export async function setupAccountWhatsAppInbox({ organizationId, senderConfig, output = '.env.whatsapp.local', apply = false } = {}) {
  if (!apply) throw new Error('Pass --apply to configure the private WhatsApp reply queue.');
  if (!Number.isSafeInteger(Number(organizationId)) || Number(organizationId) < 1) throw new Error('Provide the organization that owns this WhatsApp sender.');
  loadSharedWhatsAppSender(senderConfig);
  const senderId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!senderId) throw new Error('Configure the existing WhatsApp sender first.');
  const region = process.env.WHATSAPP_AWS_REGION || process.env.AWS_REGION || 'ap-south-1';
  const credentials = process.env.WHATSAPP_AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.WHATSAPP_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.WHATSAPP_AWS_SECRET_ACCESS_KEY,
    ...(process.env.WHATSAPP_AWS_SESSION_TOKEN ? { sessionToken: process.env.WHATSAPP_AWS_SESSION_TOKEN } : {}),
  } : undefined;
  const config = { region, ...(credentials ? { credentials } : {}), maxAttempts: 1,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000, throwOnRequestTimeout: true } };
  const social = new SocialMessagingClient(config), sns = new SNSClient(config), sqs = new SQSClient(config);
  try {
    const phone = await social.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: senderId }));
    const response = await social.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: phone.linkedWhatsAppBusinessAccountId }));
    const account = response.account;
    if (!account?.arn || !account.id) throw new Error('The WhatsApp business account could not be verified.');
    const accountId = account.arn.split(':')[4];
    const suffix = createHash('sha256').update(`${organizationId}:${senderId}`).digest('hex').slice(0,10);
    const name = `dgg-accounts-whatsapp-${suffix}`;
    const destinations = account.eventDestinations || [];
    if (destinations.length > 1 || destinations.some(item => !String(item.eventDestinationArn).includes(':sns:'))) throw new Error('The existing WABA event destination needs review; it will not be replaced.');
    // Reuse an existing SNS destination instead of replacing a different app's route.
    let topicArn = destinations[0]?.eventDestinationArn;
    const reuseExistingTopic = Boolean(topicArn);
    if (!topicArn) {
      const created = await sns.send(new CreateTopicCommand({ Name: name, Tags: [{ Key: 'Application', Value: 'account-whatsapp-inbox' }, { Key: 'Organization', Value: String(organizationId) }] }));
      topicArn = created.TopicArn;
    }
    if (!topicArn) throw new Error('AWS did not return the incoming topic.');
    const topic = await sns.send(new GetTopicAttributesCommand({ TopicArn: topicArn }));
    await sns.send(new SetTopicAttributesCommand({ TopicArn: topicArn, AttributeName: 'Policy', AttributeValue: mergeWhatsAppResourcePolicy(topic.Attributes?.Policy, whatsappTopicPublishStatement(topicArn, account.arn)) }));
    if (!reuseExistingTopic) await sns.send(new SetTopicAttributesCommand({ TopicArn: topicArn, AttributeName: 'SignatureVersion', AttributeValue: '2' }));
    const queueAttributes = { MessageRetentionPeriod: '1209600', SqsManagedSseEnabled: 'true', VisibilityTimeout: '60', ReceiveMessageWaitTimeSeconds: '20' };
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dead`, Attributes: queueAttributes, tags: { Application: 'account-whatsapp-inbox', Organization: String(organizationId) } }));
    const dead = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
    const created = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { ...queueAttributes, RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dead.Attributes.QueueArn, maxReceiveCount: 5 }) }, tags: { Application: 'account-whatsapp-inbox', Organization: String(organizationId) } }));
    const queue = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: created.QueueUrl, AttributeNames: ['QueueArn', 'Policy'] }));
    const queueArn = queue.Attributes.QueueArn;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: created.QueueUrl, Attributes: { Policy: mergeWhatsAppResourcePolicy(queue.Attributes.Policy, whatsappQueueDeliveryStatement(queueArn, topicArn)) } }));
    let subscriptionArn, nextToken;
    do {
      const subscriptions = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken }));
      subscriptionArn = subscriptions.Subscriptions?.find(item => item.Protocol === 'sqs' && item.Endpoint === queueArn)?.SubscriptionArn;
      nextToken = subscriptions.NextToken;
    } while (!subscriptionArn && nextToken);
    if (!subscriptionArn) subscriptionArn = (await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn, ReturnSubscriptionArn: true }))).SubscriptionArn;
    if (!subscriptionArn || subscriptionArn === 'PendingConfirmation') throw new Error('AWS has not confirmed the private queue subscription.');
    // Preserve the signed SNS envelope; the worker verifies it before ingesting.
    await sns.send(new SetSubscriptionAttributesCommand({ SubscriptionArn: subscriptionArn, AttributeName: 'RawMessageDelivery', AttributeValue: 'false' }));
    const fresh = (await social.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: account.id }))).account;
    if (fresh.eventDestinations?.some(item => item.eventDestinationArn !== topicArn)) throw new Error('The event destination changed during setup; it was left untouched.');
    if (!fresh.eventDestinations?.length) await social.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id: account.id, eventDestinations: [{ eventDestinationArn: topicArn }] }));
    const final = (await social.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: account.id }))).account;
    if (!final.eventDestinations?.some(item => item.eventDestinationArn === topicArn)) throw new Error('The WhatsApp event destination did not become active.');
    const settings = {
      WHATSAPP_INBOX_ORGANIZATION_ID: String(organizationId), WHATSAPP_INBOX_AWS_ACCOUNT_ID: accountId,
      WHATSAPP_SNS_TOPIC_ARN: topicArn, WHATSAPP_INBOX_QUEUE_URL: created.QueueUrl,
    };
    const target = path.resolve(output);
    const text = '# Private WhatsApp inbox routing. Sender credentials stay in the existing sender environment.\n' + Object.entries(settings).map(([key,value]) => `${key}=${value}`).join('\n') + '\n';
    fs.writeFileSync(target, text, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    return { sender_name: phone.phoneNumber?.displayPhoneNumberName, organization_id: Number(organizationId), event_destination_configured: true, private_queue_configured: true, settings_file: target, customer_messages_sent: 0 };
  } finally { social.destroy(); sns.destroy(); sqs.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  setupAccountWhatsAppInbox({ organizationId: value('--organization-id'), senderConfig: value('--sender-config'), output: args.includes('--output') ? value('--output') : undefined, apply: args.includes('--apply') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error('WhatsApp inbox setup failed:', error.name, error.message); process.exitCode = 1; });
}
