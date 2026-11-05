import 'dotenv/config';
import pool from '../src/config/db.js';
import { createSeekPermissionPreviewAuth } from '../src/middlewares/seekPermissionPreviewAuth.middleware.js';
import { createPermissionsPreviewApp } from '../src/preview/permissionsPreview.js';

const { authenticate } = createSeekPermissionPreviewAuth({ database: pool });
const app = createPermissionsPreviewApp({ authenticate });
const port = Number(process.env.PERMISSIONS_PREVIEW_PORT || 8007);
const server = app.listen(port, '127.0.0.1', () => console.log(`Permissions preview ready on http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});
