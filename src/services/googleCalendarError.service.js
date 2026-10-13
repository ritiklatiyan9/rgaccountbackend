// Expose actionable provider errors without returning OAuth responses or tokens.
export const calendarSyncError = (error) => {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  if (/accessNotConfigured|SERVICE_DISABLED|Calendar API has not been used|Calendar API.*disabled/i.test(message)) {
    const project = message.match(/(?:project[=\s]|projects\/)(\d+)/i)?.[1];
    return {
      code: 'API_DISABLED',
      message: 'Google Calendar API is disabled for the connected Google project. Enable it, then refresh future events.',
      setup_url: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com${project ? `?project=${project}` : ''}`,
    };
  }
  if (/invalid_grant|Token has been expired or revoked/i.test(message)) {
    return { code: 'RECONNECT_REQUIRED', message: 'Reconnect this Google account in Calendar settings, then refresh future events.' };
  }
  return { code: 'SYNC_FAILED', message: 'Google Calendar could not sync. Refresh future events to retry.' };
};
