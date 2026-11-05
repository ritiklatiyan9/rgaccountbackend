import express from 'express';
import cors from 'cors';
import requireRole from '../middlewares/role.middleware.js';
import errorMiddleware from '../middlewares/error.middleware.js';
import { getCaWorkflow, updateCaWorkflow, getExcelUploadAccess, getExcelImportCatalog } from '../controllers/caWorkflow.controller.js';
import { prepareExcelImport } from '../services/caExcelImport.service.js';

export function createCaWorkflowPreviewApp({ authenticate, request = fetch }) {
  const app = express();
  app.use(cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'], credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ service: 'ca-workflow-preview' }));
  app.use(authenticate);
  app.get('/settings/ca-workflow/access', getExcelUploadAccess);
  app.get('/settings/ca-workflow/imports', getExcelImportCatalog);
  app.get('/settings/ca-workflow', requireRole('admin'), getCaWorkflow);
  app.put('/settings/ca-workflow/:userId', requireRole('admin'), updateCaWorkflow);
  app.post('/ca-excel-import', async (req, res, next) => {
    try {
      const { target, body } = await prepareExcelImport(req.user, req.body);
      // Only fixed catalogue targets reach the hosted create routes. The hosted
      // API independently validates the current session and module permissions.
      const upstream = await request(`https://rgaccountbackend.onrender.com${target}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { Authorization: req.get('Authorization'), 'X-App-Context': 'accounts',
          'Content-Type': 'application/json', ...(req.get('X-Session-ID') ? { 'X-Session-ID': req.get('X-Session-ID') } : {}) },
        body: JSON.stringify(body),
      });
      res.status(upstream.status).json(await upstream.json());
    } catch (error) { next(error); }
  });
  app.use(errorMiddleware);
  return app;
}
