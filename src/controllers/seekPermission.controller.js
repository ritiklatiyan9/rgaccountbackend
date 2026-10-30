import asyncHandler from '../utils/asyncHandler.js';
import { emitToUser } from '../config/socket.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';
import * as seek from '../services/seekPermission.service.js';

// Live bell: push the change to every open tab that shows this request. Runs
// after the response; the 30-second bell poll covers a socket that is down.
const broadcast = (request) => {
  const payload = {
    id: request.id, site_id: request.site_id, site_name: request.site_name, status: request.status,
    title: request.title, amount: request.amount, priority: request.priority, requested_by: request.requested_by,
    requested_by_name: request.requested_by_name, asked_to: request.asked_to,
    asked_to_name: request.asked_to_name, decided_by_name: request.decided_by_name,
  };
  seek.seekRecipients(request)
    .then(ids => ids.forEach(id => emitToUser(id, 'seek_permission:changed', payload)))
    .catch(error => console.error('Seek permission push failed:', error.message));
};

const noStore = res => res.set('Cache-Control', 'no-store');

export const getSeekPermission = asyncHandler(async (req, res) => {
  noStore(res).json({ request: await seek.getSeekPermission(req.user, req.params.id) });
});

export const getSeekComments = asyncHandler(async (req, res) => {
  noStore(res).json(await seek.listSeekComments(req.user, req.params.id, req.query));
});

export const createSeekComment = asyncHandler(async (req, res) => {
  const { comment, created, request, ...metadata } = await seek.createSeekComment(req.user, req.params.id, req.body);
  if (created) {
    // Socket rooms contain no request text: every recipient must fetch the delta
    // through current access checks, even if a site's membership just changed.
    seek.seekRecipients(request)
      .then(ids => ids.forEach(id => emitToUser(id, 'seek_permission:comment', {
        id: request.id, request_id: request.id, site_id: request.site_id, comment_id: comment.id, author_id: comment.author_id,
        comment_count: metadata.comment_count, last_comment_at: metadata.last_comment_at, priority: request.priority,
      })))
      .catch(error => console.error('Seek permission comment push failed:', error.message));
  }
  noStore(res).status(created ? 201 : 200).json({ comment, ...metadata });
});

export const markSeekCommentsSeen = asyncHandler(async (req, res) => {
  noStore(res).json(await seek.markSeekCommentsSeen(req.user, req.params.id, req.body));
});

export const listSeekPermissions = asyncHandler(async (req, res) => {
  noStore(res).json({ requests: await seek.listSeekPermissions(req.user, req.query) });
});

export const getSeekInbox = asyncHandler(async (req, res) => {
  noStore(res).json(await seek.seekInbox(req.user, req.query));
});

export const getSeekTargets = asyncHandler(async (req, res) => {
  noStore(res).json({ people: await seek.listSeekTargets(req.user, req.query) });
});

export const createSeekPermission = asyncHandler(async (req, res) => {
  try {
    const request = await seek.createSeekPermission(req.user, req.body, undefined, req.files || []);
    broadcast(request);
    res.status(201).json({ request, message: `Permission request sent to ${request.asked_to_name || 'admin'}` });
  } finally {
    (req.files || []).forEach(file => cleanupFile(file.path));
  }
});

export const getSeekAttachment = asyncHandler(async (req, res) => {
  noStore(res).json(await seek.seekAttachmentUrl(req.user, req.params.id, req.params.index));
});

export const decideSeekPermission = decision => asyncHandler(async (req, res) => {
  const request = await seek.decideSeekPermission(req.user, req.params.id, decision, req.body?.note);
  broadcast(request);
  res.json({ request, message: decision === 'approve' ? 'Permission approved' : 'Permission rejected' });
});

export const cancelSeekPermission = asyncHandler(async (req, res) => {
  const request = await seek.cancelSeekPermission(req.user, req.params.id);
  broadcast(request);
  res.json({ request, message: 'Request withdrawn' });
});

export const markSeekSeen = asyncHandler(async (req, res) => {
  res.json({ seen: await seek.markSeekSeen(req.user, req.body) });
});

export const getSeekAccess = asyncHandler(async (req, res) => {
  noStore(res).json({ users: await seek.listSeekAccess(req.user, req.query) });
});

export const updateSeekAccess = asyncHandler(async (req, res) => {
  const access = await seek.setSeekAccess(req.user, req.params.userId, req.body);
  const message = access.scope === 'all' ? 'Can now see every request on this site'
    : access.scope === 'selected' ? `Can now see own requests + ${access.user_ids.length} selected ${access.user_ids.length === 1 ? 'person' : 'people'}`
      : 'Can now see own requests only';
  res.json({ access, message });
});
