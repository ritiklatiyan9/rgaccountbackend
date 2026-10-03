import { Router } from 'express';
import { resolveDriveDocumentLink } from '../services/driveDocumentLinks.service.js';

const router = Router();
// Bearer capability links are used by the CA outside an app login. The service
// authenticates the encrypted scope and current Drive permissions on each open.
router.get('/:token', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  try {
    const url = await resolveDriveDocumentLink(req.params.token);
    res.redirect(302, url);
  } catch (err) {
    const known = typeof err?.code === 'string' && err.code.startsWith('DRIVE_DOCUMENT_');
    res.status(known ? err.statusCode || 403 : 503).type('text/plain').send(known ? err.message : 'Document access is temporarily unavailable. Please try again.');
  }
});

export default router;
