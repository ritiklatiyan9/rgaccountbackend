import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { getDocumentation, putDocumentation, batchDocumentation, getDocumentationDefaults, getDocumentationPolicies, putDocumentationPolicy, getDocumentationGaps } from '../controllers/transactionDocumentation.controller.js';
const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));
const invalidate = invalidateCacheOnSuccess(['documentation-gaps|', 'approvals|', 'expenses|', 'expenses:page:', 'expenses:breakdown:', '/expenses']);
router.get('/defaults', getDocumentationDefaults);
router.get('/policies', getDocumentationPolicies);
router.put('/policies/:source', invalidate, putDocumentationPolicy);
// The gap list evaluates every candidate record, so administrators (whose grants
// cannot change between requests) share a short cache; writes clear it.
const gapsCache = cacheResponse({ ttlSeconds: 60, namespace: 'documentation-gaps' });
router.get('/gaps', (req, res, next) => ['admin', 'super_admin'].includes(req.user?.role) ? gapsCache(req, res, next) : next(), getDocumentationGaps);
router.post('/batch', batchDocumentation);
router.get('/:source/:id', getDocumentation);
router.put('/:source/:id', invalidate, putDocumentation);
export default router;
