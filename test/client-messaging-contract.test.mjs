import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('messaging data is durable, site scoped, consent audited and recipient unique', async () => {
  const migration = await source('src/migrations/142_client_messaging_campaigns.js');

  assert.match(migration, /site_id\s+INTEGER NOT NULL REFERENCES sites\(id\) ON DELETE CASCADE/);
  assert.match(migration, /consent_confirmed\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /UNIQUE \(campaign_id, member_id, channel\)/);
  assert.match(migration, /CHECK \(channels = ARRAY\['SMS'\]::text\[\]\)/);
  assert.match(migration, /channel = 'SMS'/);
  assert.doesNotMatch(migration, /WHATSAPP|EMAIL/);
  assert.match(migration, /idx_client_message_deliveries_campaign_status/);
});

test('message APIs require analytics visibility plus separate messaging permission', async () => {
  const [routes, permissions] = await Promise.all([
    source('src/routes/managementAnalytics.routes.js'),
    source('src/models/Permission.model.js'),
  ]);

  assert.match(routes, /router\.use\([\s\S]*requirePermission\('management_analytics', 'read'\)/);
  assert.match(routes, /messaging\/recipients'[\s\S]*requirePermission\('client_messaging', 'read'\)/);
  assert.match(routes, /messaging\/campaigns'[\s\S]*requirePermission\('client_messaging', 'write'\)/);
  assert.match(routes, /messagingLimiter/);
  assert.match(permissions, /'client_messaging'/);
  assert.match(permissions, /RESTRICTED_MODULES[\s\S]*'client_messaging'/);
});

test('campaign creation enforces assigned-site scope, consent and bulk limits', async () => {
  const controller = await source('src/controllers/managementAnalyticsMessaging.controller.js');

  assert.match(controller, /assertSiteAccess\(req\.user, scope\.siteId\)/);
  assert.match(controller, /consent_confirmed !== true/);
  assert.match(controller, /const MAX_RECIPIENTS = 500/);
  assert.match(controller, /m\.site_id = \$1/);
  assert.match(controller, /CLIENT_SCOPE/);
  assert.match(controller, /Duplicate destination in this campaign/);
  assert.match(controller, /status: !destination \|\| duplicate \? 'SKIPPED' : 'QUEUED'/);
});

test('AWS SMS delivery is asynchronous and uses the official SMS client', async () => {
  const [queue, worker] = await Promise.all([
    source('src/services/clientMessagingQueue.service.js'),
    source('src/workers/clientMessagingWorker.js'),
  ]);

  assert.match(queue, /SendMessageBatchCommand/);
  assert.match(queue, /start \+= 10/);
  assert.match(worker, /PinpointSMSVoiceV2Client/);
  assert.doesNotMatch(worker, /SESv2Client|SendEmailCommand|SocialMessagingClient|SendWhatsAppMessage|WHATSAPP|EMAIL/);
  assert.match(worker, /ApproximateReceiveCount/);
  assert.match(worker, /receiveCount >= 5/);
  assert.match(worker, /WHERE id=\$1 AND campaign_id=\$2 AND status='QUEUED'/);
});

test('WhatsApp retirement keeps history but blocks new campaign rows', async () => {
  const retirement = await source('src/migrations/143_remove_client_messaging_whatsapp.js');

  assert.match(retirement, /status='FAILED'/);
  assert.match(retirement, /channel='WHATSAPP'/);
  assert.match(retirement, /client_message_campaigns_no_whatsapp/);
  assert.match(retirement, /client_message_deliveries_no_whatsapp/);
  assert.match(retirement, /NOT VALID/);
});

test('email retirement keeps history while making client messaging SMS-only', async () => {
  const retirement = await source('src/migrations/144_remove_client_messaging_email.js');

  assert.match(retirement, /status='FAILED'/);
  assert.match(retirement, /channel='EMAIL'/);
  assert.match(retirement, /client_message_campaigns_sms_only/);
  assert.match(retirement, /client_message_deliveries_sms_only/);
  assert.match(retirement, /CHECK \(channels = ARRAY\['SMS'\]::text\[\]\) NOT VALID/);
});
