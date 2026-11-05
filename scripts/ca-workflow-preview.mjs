import 'dotenv/config';
import pool from '../src/config/db.js';
import { createSeekPermissionPreviewAuth } from '../src/middlewares/seekPermissionPreviewAuth.middleware.js';
import { createCaWorkflowPreviewApp } from '../src/preview/caWorkflowPreview.js';

const { authenticate } = createSeekPermissionPreviewAuth({ database: pool });
const app = createCaWorkflowPreviewApp({ authenticate });
const port = Number(process.env.CA_WORKFLOW_PREVIEW_PORT || 8008);
const server = app.listen(port, '127.0.0.1', () => console.log(`CA Workflow ready on http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});
