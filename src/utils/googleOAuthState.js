import crypto from 'crypto';

/**
 * HMAC-signed OAuth `state` shared by the Google Calendar and Google Drive
 * flows. Both integrations use the same OAuth client and redirect URI, so the
 * callback needs the `kind` to know which connection table the tokens belong
 * to. The browser redirect from Google carries no auth header: this signed
 * blob (minted by the authenticated /connect call) is the whole proof of who
 * initiated the flow.
 */
const STATE_TTL_MS = 10 * 60 * 1000;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const stateSecret = () => String(process.env.CALENDAR_TOKEN_ENC_KEY || '');

export const signOAuthState = ({ orgId, userId, origin, kind = 'calendar' }) => {
  const payload = Buffer.from(JSON.stringify({
    o: orgId, u: userId, r: origin, k: kind, e: Date.now() + STATE_TTL_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

export const verifyOAuthState = (state) => {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.o || !data.e || Date.now() > data.e) return null;
    // States minted before Drive existed have no `k`: they are calendar states.
    return { orgId: data.o, userId: data.u, origin: data.r || FRONTEND_URL, kind: data.k || 'calendar' };
  } catch {
    return null;
  }
};
