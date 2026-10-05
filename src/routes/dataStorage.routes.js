import express from 'express';
import multer from 'multer';
import { pipeline } from 'node:stream/promises';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import { dataStorageFiles } from '../utils/dataStorageFiles.js';
import { createDataStorageService, MAX_STORAGE_FILE_BYTES } from '../services/dataStorage.service.js';

// Dependencies are injectable so API tests use isolated storage and PostgreSQL.
export function createDataStorageRouter({ database = pool, files = dataStorageFiles, authenticate = authMiddleware, permission = requirePermission } = {}) {
  const router = express.Router();
  const service = createDataStorageService(database, files);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_STORAGE_FILE_BYTES, files: 1, fields: 2, fieldSize: 1024 } });
  const receiveFile = (req, res, next) => upload.single('file')(req, res, (error) => {
    if (!error) return next();
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      message: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 50 MB or smaller.' : 'Upload one file per request with a site and destination folder.',
    });
  });
  router.use(authenticate);
  router.get('/', permission('data_storage', 'read'), asyncHandler(async (req, res) => res.json(await service.list(req.user, req.query))));
  router.post('/folders', permission('data_storage', 'write'), asyncHandler(async (req, res) => res.status(201).json({ entry: await service.createFolder(req.user, req.body) })));
  router.post('/files', permission('data_storage', 'write'), receiveFile, asyncHandler(async (req, res) => res.status(201).json({ entry: await service.upload(req.user, req.body, req.file) })));
  const sendFile = (inline) => asyncHandler(async (req, res) => {
    const file = await service.download(req.user, req.query.site_id, req.params.id);
    res.attachment(file.name);
    if (inline) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    try { await pipeline(file.stream, res); }
    catch (error) { if (!res.destroyed) throw error; }
  });
  // The app creates safe typed blobs for previews. Raw HTML/SVG uploads are
  // never served as active content from the authenticated application's origin.
  router.get('/:id/preview', permission('data_storage', 'read'), sendFile(true));
  router.get('/:id/download', permission('data_storage', 'read'), sendFile(false));
  router.patch('/:id', permission('data_storage', 'update'), asyncHandler(async (req, res) => res.json({ entry: await service.rename(req.user, req.query.site_id, req.params.id, req.body) })));
  router.delete('/:id', permission('data_storage', 'delete'), asyncHandler(async (req, res) => res.json(await service.remove(req.user, req.query.site_id, req.params.id))));
  return router;
}

export default createDataStorageRouter();
