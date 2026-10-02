/** Explicit backup grants cover the whole database, including all sites. */
export const createBackupAdminGuard = (db, action = 'read') => async (req,res,next) => {
  if (!req.user) return res.status(401).json({ message:'Authentication required.' });
  try {
    // Read the live role as well as the token: a demoted administrator must not
    // retain access to other organizations' data until their token expires.
    const { rows:[user] } = await db.query('SELECT role,is_active FROM users WHERE id=$1',[req.user.id]);
    if (!user?.is_active || user.role !== req.user.role) return res.status(403).json({ message:'Your account access has changed. Sign in again before using backups.' });
    if (!['read','restore'].includes(action)) return res.status(403).json({ message:'Invalid backup action.' });
    if (!['admin','super_admin'].includes(user.role)) {
      if (user.role !== 'sub_admin') return res.status(403).json({ message:'Backup access has not been granted to your account.' });
      const { rows:[permission] } = await db.query('SELECT can_read,can_restore FROM user_permissions WHERE user_id=$1 AND module=$2',[req.user.id,'backups']);
      if (permission?.can_read !== true || (action === 'restore' && permission.can_restore !== true)) {
        return res.status(403).json({ message:action === 'restore' ? 'You do not have permission to restore backups.' : 'You do not have permission to view or download backups.' });
      }
    }
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Pragma','no-cache');
    next();
  } catch (error) { next(error); }
};
