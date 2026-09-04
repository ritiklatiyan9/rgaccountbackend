import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { assertSiteAccess, parseScope } from './managementAnalytics.controller.js';
import {
  enqueueClientMessages, isClientMessageQueueConfigured,
} from '../services/clientMessagingQueue.service.js';

const CHANNELS = new Set(['SMS']);
const CONTACT_FILTERS = new Set(['ANY', 'ALL', 'SMS']);
const AUDIENCE_MODES = new Set(['SELECTED', 'FILTERED']);
const CLIENT_SCOPE = `'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[UPPER(COALESCE(m.member_type,''))]))
  AND LOWER(COALESCE(m.status,'active')) <> 'deleted'`;
const MAX_RECIPIENTS = 500;

const text = (value, max = 1000) => String(value || '').trim().slice(0, max);
const normalisePhone = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? `+${digits}` : null;
};
const cleanFilters = (raw = {}) => ({
  search: text(raw.search, 100),
  city: text(raw.city, 100),
  team: text(raw.team, 100),
  status: text(raw.status, 30).toUpperCase(),
  contact: CONTACT_FILTERS.has(String(raw.contact || '').toUpperCase()) ? String(raw.contact).toUpperCase() : 'ANY',
});

const recipientWhere = (siteId, rawFilters = {}, memberIds = null) => {
  const filters = cleanFilters(rawFilters);
  const values = [siteId];
  const conditions = [`m.site_id = $1`, CLIENT_SCOPE];
  const add = (sql, value) => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.search) {
    values.push(`%${filters.search}%`);
    const searchParam = `$${values.length}`;
    conditions.push(`(m.full_name ILIKE ${searchParam} OR m.phone ILIKE ${searchParam} OR m.alt_phone ILIKE ${searchParam})`);
  }
  if (filters.city) add(`UPPER(TRIM(COALESCE(m.city,''))) = UPPER(?)`, filters.city);
  if (filters.team) add(`UPPER(TRIM(COALESCE(m.team,''))) = UPPER(?)`, filters.team);
  if (filters.status) add(`UPPER(COALESCE(m.status,'ACTIVE')) = ?`, filters.status);
  if (filters.contact === 'SMS') conditions.push(`COALESCE(NULLIF(TRIM(m.phone),''), NULLIF(TRIM(m.alt_phone),'')) IS NOT NULL`);
  if (filters.contact === 'ANY') conditions.push(`COALESCE(NULLIF(TRIM(m.phone),''), NULLIF(TRIM(m.alt_phone),'')) IS NOT NULL`);
  if (Array.isArray(memberIds)) add(`m.id = ANY(?::int[])`, memberIds);
  return { where: conditions.join(' AND '), values, filters };
};

const scopeOrReject = async (req, res, source = 'query') => {
  const scope = parseScope(req, res, source);
  if (!scope) return null;
  await assertSiteAccess(req.user, scope.siteId);
  return scope;
};

const providerStatus = () => ({
  queue: Boolean(isClientMessageQueueConfigured()),
  sms: Boolean(process.env.AWS_SMS_ORIGINATION_IDENTITY),
  region: process.env.AWS_REGION || 'ap-south-1',
});

/** GET /management-analytics/messaging/recipients */
export const listMessageRecipients = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const query = recipientWhere(scope.siteId, req.query);

  const [rows, count, facets, status] = await Promise.all([
    pool.query(
      `SELECT m.id, m.full_name AS name, m.phone, m.alt_phone,
              m.city, m.state, m.team, m.status,
              (COALESCE(NULLIF(TRIM(m.phone),''), NULLIF(TRIM(m.alt_phone),'')) IS NOT NULL) AS has_sms
         FROM members m WHERE ${query.where}
        ORDER BY m.full_name, m.id LIMIT $${query.values.length + 1} OFFSET $${query.values.length + 2}`,
      [...query.values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM members m WHERE ${query.where}`, query.values),
    pool.query(
      `SELECT
         ARRAY(SELECT DISTINCT TRIM(city) FROM members m WHERE m.site_id=$1 AND ${CLIENT_SCOPE} AND NULLIF(TRIM(city),'') IS NOT NULL ORDER BY 1) AS cities,
         ARRAY(SELECT DISTINCT TRIM(team) FROM members m WHERE m.site_id=$1 AND ${CLIENT_SCOPE} AND NULLIF(TRIM(team),'') IS NOT NULL ORDER BY 1) AS teams`,
      [scope.siteId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS clients,
              COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(phone),''),NULLIF(TRIM(alt_phone),'')) IS NOT NULL)::int AS sms
         FROM members m WHERE m.site_id=$1 AND ${CLIENT_SCOPE}`,
      [scope.siteId]
    ),
  ]);

  const total = count.rows[0]?.total || 0;
  res.json({
    recipients: rows.rows,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    facets: facets.rows[0] || { cities: [], teams: [] },
    availability: status.rows[0] || {},
  });
});

/** GET /management-analytics/messaging/overview */
export const getMessagingOverview = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS campaigns,
            COALESCE(SUM(recipient_count),0)::int AS recipients,
            COALESCE(SUM(sent_count),0)::int AS sent,
            COALESCE(SUM(failed_count),0)::int AS failed
       FROM client_message_campaigns WHERE site_id=$1`,
    [scope.siteId]
  );
  res.json({ summary: rows[0], providers: providerStatus(), limits: { max_recipients: MAX_RECIPIENTS } });
});

/** GET /management-analytics/messaging/campaigns */
export const listMessageCampaigns = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit, 10) || 20));
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(NULLIF(TRIM(u.name),''),u.email) AS created_by_name
       FROM client_message_campaigns c LEFT JOIN users u ON u.id=c.created_by
      WHERE c.site_id=$1 ORDER BY c.created_at DESC, c.id DESC LIMIT $2`,
    [scope.siteId, limit]
  );
  res.json({ campaigns: rows });
});

const render = (template, client, siteName) => String(template || '').replace(
  /\{\{\s*(name|site|city|phone)\s*\}\}/gi,
  (_, key) => ({
    name: client.name || 'Customer', site: siteName || '', city: client.city || '',
    phone: client.phone || client.alt_phone || '',
  })[key.toLowerCase()]
);

/** POST /management-analytics/messaging/campaigns */
export const createMessageCampaign = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res, 'body');
  if (!scope) return;
  if (!isClientMessageQueueConfigured()) return res.status(503).json({ message: 'AWS client message queue is not configured' });
  if (req.body.consent_confirmed !== true) return res.status(400).json({ message: 'Confirm that the selected clients consented to receive these messages' });

  const title = text(req.body.title, 180);
  const message = text(req.body.message, 10000);
  const channels = [...new Set((Array.isArray(req.body.channels) ? req.body.channels : []).map((value) => String(value).toUpperCase()))];
  const audienceMode = String(req.body.audience_mode || '').toUpperCase();
  const messageType = String(req.body.message_type || 'TRANSACTIONAL').toUpperCase();

  if (!title) return res.status(400).json({ message: 'Campaign title is required' });
  if (!message) return res.status(400).json({ message: 'Message is required' });
  if (channels.length !== 1 || channels[0] !== 'SMS') return res.status(400).json({ message: 'SMS is the only supported channel' });
  if (!AUDIENCE_MODES.has(audienceMode)) return res.status(400).json({ message: 'Choose selected clients or all filtered clients' });
  if (!['TRANSACTIONAL', 'PROMOTIONAL'].includes(messageType)) return res.status(400).json({ message: 'Invalid message type' });
  if (message.length > 1500) return res.status(400).json({ message: 'SMS message must be 1500 characters or fewer' });

  const providers = providerStatus();
  const unavailable = channels.filter((channel) => !providers[channel.toLowerCase()]);
  if (unavailable.length) return res.status(503).json({ message: `${unavailable.join(', ')} delivery is not configured` });

  const memberIds = audienceMode === 'SELECTED'
    ? [...new Set((Array.isArray(req.body.member_ids) ? req.body.member_ids : []).map((id) => Number.parseInt(id, 10)).filter((id) => id > 0))]
    : null;
  if (audienceMode === 'SELECTED' && !memberIds.length) return res.status(400).json({ message: 'Select at least one client' });
  if (memberIds?.length > MAX_RECIPIENTS) return res.status(400).json({ message: `A campaign can include at most ${MAX_RECIPIENTS} clients` });

  const filters = cleanFilters(req.body.filters || {});
  // Selected clients stay in the audit trail even when a chosen channel is missing;
  // those deliveries are recorded as SKIPPED below instead of silently disappearing.
  const recipientQuery = recipientWhere(
    scope.siteId,
    audienceMode === 'FILTERED' ? filters : { contact: 'ALL' },
    memberIds
  );
  const recipientResult = await pool.query(
    `SELECT m.id, m.full_name AS name, m.phone, m.alt_phone, m.city
       FROM members m WHERE ${recipientQuery.where} ORDER BY m.id LIMIT $${recipientQuery.values.length + 1}`,
    [...recipientQuery.values, MAX_RECIPIENTS + 1]
  );
  if (recipientResult.rows.length > MAX_RECIPIENTS) return res.status(400).json({ message: `Narrow the audience to ${MAX_RECIPIENTS} clients or fewer` });
  if (!recipientResult.rows.length) return res.status(400).json({ message: 'No clients match this audience' });

  const site = await pool.query('SELECT name FROM sites WHERE id=$1', [scope.siteId]);
  const siteName = site.rows[0]?.name || `Site ${scope.siteId}`;
  const seen = new Set();
  const deliveries = [];
  for (const client of recipientResult.rows) {
    for (const channel of channels) {
      const rawDestination = client.phone || client.alt_phone;
      const destination = normalisePhone(rawDestination);
      const duplicate = destination && seen.has(`${channel}:${destination}`);
      if (destination && !duplicate) seen.add(`${channel}:${destination}`);
      deliveries.push({
        member_id: client.id,
        client_name: client.name,
        channel,
        destination: destination || '(missing)',
        rendered_subject: null,
        rendered_message: render(message, client, siteName),
        status: !destination || duplicate ? 'SKIPPED' : 'QUEUED',
        error: !destination ? `No valid ${channel.toLowerCase()} destination` : duplicate ? 'Duplicate destination in this campaign' : null,
      });
    }
  }
  const queueable = deliveries.filter((delivery) => delivery.status === 'QUEUED');
  if (!queueable.length) return res.status(400).json({ message: 'None of the selected clients has a valid destination for the chosen channels' });

  const client = await pool.connect();
  let campaign;
  let inserted;
  try {
    await client.query('BEGIN');
    const campaignResult = await client.query(
      `INSERT INTO client_message_campaigns
         (site_id,title,message,channels,message_type,audience_mode,audience_filters,
          recipient_count,delivery_count,skipped_count,status,consent_confirmed,consent_confirmed_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'QUEUING',TRUE,NOW(),$11) RETURNING *`,
      [scope.siteId, title, message, channels, messageType,
       audienceMode, JSON.stringify(audienceMode === 'FILTERED' ? filters : { member_ids: memberIds }),
       recipientResult.rows.length, deliveries.length, deliveries.length - queueable.length, req.user.id]
    );
    campaign = campaignResult.rows[0];

    const values = [];
    const placeholders = deliveries.map((delivery, index) => {
      const base = index * 10;
      values.push(campaign.id, scope.siteId, delivery.member_id, delivery.client_name, delivery.channel,
        delivery.destination, delivery.rendered_subject, delivery.rendered_message, delivery.status, delivery.error);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
    });
    inserted = await client.query(
      `INSERT INTO client_message_deliveries
         (campaign_id,site_id,member_id,client_name,channel,destination,rendered_subject,rendered_message,status,error)
       VALUES ${placeholders.join(',')} RETURNING id, member_id, channel, destination, rendered_subject, rendered_message, status`,
      values
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const jobs = inserted.rows.filter((delivery) => delivery.status === 'QUEUED').map((delivery) => ({
    delivery_id: delivery.id,
    campaign_id: campaign.id,
    channel: delivery.channel,
    destination: delivery.destination,
    message: delivery.rendered_message,
    title,
    message_type: messageType,
  }));
  const queued = await enqueueClientMessages(jobs);
  for (const failure of queued.failed) {
    await pool.query(
      `UPDATE client_message_deliveries SET status='FAILED', error=$1, updated_at=NOW() WHERE id=$2`,
      [String(failure.error).slice(0, 1000), jobs[failure.index].delivery_id]
    );
  }
  const failed = queued.failed.length;
  const initialStatus = queued.queued === 0 ? 'FAILED' : failed ? 'PARTIAL' : 'QUEUED';
  const updated = await pool.query(
    `UPDATE client_message_campaigns
        SET queued_count=$1, failed_count=$2, status=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *`,
    [queued.queued, failed, initialStatus, campaign.id]
  );
  res.status(202).json({ campaign: updated.rows[0], queued: queued.queued, failed, skipped: deliveries.length - queueable.length });
});
