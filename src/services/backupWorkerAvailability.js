/** A held worker session lock is observable without acquiring/releasing it. */
export async function backupWorkerAvailable(database) {
  const { rows: [row] } = await database.query(`SELECT EXISTS (
    SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.classid=734921 AND l.objid=1 AND l.objsubid=2 AND l.granted
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND a.application_name='accounts-backup-metadata'
  ) AS online`);
  return row?.online === true;
}
