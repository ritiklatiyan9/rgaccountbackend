// pg-pool checkout timeouts have no SQLSTATE. They indicate a temporary
// database failure, not an invalid password or revoked user session.
export function isDatabaseUnavailable(error) {
  return ['WALLET_READ_BUSY', 'DATABASE_READ_BUSY', 'DATABASE_POOL_BUSY'].includes(error?.code) || /^08/.test(String(error?.code || ''))
    || ['53300', '57P01', '57P02', '57P03', '57014'].includes(error?.code)
    || /^(timeout exceeded when trying to connect|Connection terminated due to connection timeout|Connection terminated unexpectedly|Query read timeout)$/.test(error?.message || '');
}
