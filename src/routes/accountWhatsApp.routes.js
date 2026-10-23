import express from "express";
import authMiddleware from "../middlewares/auth.middleware.js";
import requireRole from "../middlewares/role.middleware.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  accountWhatsAppStudio,
  saveAccountWhatsAppStage,
  createAccountWhatsAppTemplate,
  updateAccountWhatsAppTemplate,
  deleteAccountWhatsAppTemplate,
  previewAccountWhatsAppTemplate,
  testAccountWhatsAppTemplate,
  listAccountWhatsAppRemoteTemplates,
  getAccountWhatsAppRemoteTemplate,
  importAccountWhatsAppTemplate,
} from "../services/accountWhatsApp.service.js";

const router = express.Router();
router.use(authMiddleware, requireRole("admin"));
router.get(
  "/remote-templates",
  asyncHandler(async (req, res) =>
    res.json(
      await listAccountWhatsAppRemoteTemplates(req.user, req.query.site_id),
    ),
  ),
);
router.get(
  "/remote-templates/:id",
  asyncHandler(async (req, res) =>
    res.json(
      await getAccountWhatsAppRemoteTemplate(
        req.user,
        req.query.site_id,
        req.params.id,
      ),
    ),
  ),
);
router.post(
  "/templates/import",
  asyncHandler(async (req, res) =>
    res
      .status(201)
      .json(await importAccountWhatsAppTemplate(req.user, req.body || {})),
  ),
);
router.get(
  "/studio",
  asyncHandler(async (req, res) =>
    res.json(await accountWhatsAppStudio(req.user, req.query.site_id)),
  ),
);
router.put(
  "/stages/:event",
  asyncHandler(async (req, res) =>
    res.json(
      await saveAccountWhatsAppStage(
        req.user,
        req.params.event,
        req.body || {},
      ),
    ),
  ),
);
router.post(
  "/templates",
  asyncHandler(async (req, res) =>
    res
      .status(201)
      .json(await createAccountWhatsAppTemplate(req.user, req.body || {})),
  ),
);
router.patch(
  "/templates/:name",
  asyncHandler(async (req, res) =>
    res.json(
      await updateAccountWhatsAppTemplate(
        req.user,
        req.params.name,
        req.body || {},
      ),
    ),
  ),
);
router.delete(
  "/templates/:name",
  asyncHandler(async (req, res) =>
    res.json(
      await deleteAccountWhatsAppTemplate(
        req.user,
        req.params.name,
        req.query.site_id,
      ),
    ),
  ),
);
router.post(
  "/preview",
  asyncHandler(async (req, res) =>
    res.json(await previewAccountWhatsAppTemplate(req.user, req.body || {})),
  ),
);
router.post(
  "/test",
  asyncHandler(async (req, res) =>
    res.json(await testAccountWhatsAppTemplate(req.user, req.body || {})),
  ),
);
export default router;
