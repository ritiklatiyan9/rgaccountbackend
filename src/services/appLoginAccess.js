const APP_FIELDS = {
  accounts: 'can_login_accounts',
  booking_accounts: 'can_login_booking_accounts',
};
const APP_NAMES = { accounts: 'Defence Garden Accounts', booking_accounts: "Booking's Account" };
const header = (req, name) => req.get?.(name) ?? req.header?.(name) ?? req.headers?.[name.toLowerCase()];
const accessError = message => Object.assign(new Error(message), { statusCode: 403, code: 'APP_ACCESS_DENIED' });

// Browser Origin determines which Accounts frontend is asking. The explicit
// context also supports localhost and native API callers; it cannot override a
// production origin. JWT app claims independently prevent crossing app realms.
export function requestAppContext(req) {
  const explicit = header(req, 'X-App-Context');
  if (explicit && !Object.hasOwn(APP_FIELDS, explicit)) throw accessError('Invalid application context.');
  const origin = header(req, 'Origin');
  let hostname;
  if (origin) {
    try { hostname = new URL(origin).hostname.toLowerCase(); }
    catch { throw accessError('Invalid application origin.'); }
  }
  const inferred = ['dgdefence.com', 'www.dgdefence.com'].includes(hostname) ? 'accounts'
    : ['dgbooking.com', 'www.dgbooking.com'].includes(hostname) ? 'booking_accounts' : null;
  if (inferred && explicit && explicit !== inferred) throw accessError('Application context does not match this website.');
  return inferred || explicit || 'accounts';
}

export function assertAppLoginAccess(user, app, token) {
  if (!Object.hasOwn(APP_FIELDS, app)) throw accessError('Invalid application context.');
  if (user?.role === 'client' || token?.realm || token?.aud) throw accessError('This session cannot access staff Accounts.');
  const tokenApp = token?.app;
  if (tokenApp && tokenApp !== app && !(app === 'booking_accounts' && tokenApp === 'booking')) {
    throw accessError('This session belongs to another application. Please sign in here.');
  }
  if (user?.[APP_FIELDS[app]] === false) {
    throw accessError(`This ID is not allowed to sign in to ${APP_NAMES[app]}. Contact your admin.`);
  }
}
