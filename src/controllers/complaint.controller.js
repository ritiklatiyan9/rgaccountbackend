import asyncHandler from '../utils/asyncHandler.js';
import { emitToUser } from '../config/socket.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';
import { sendRequestAttachment } from '../utils/requestAttachmentContent.js';
import * as complaints from '../services/complaint.service.js';

// Live push to every open tab that may see this complaint. Runs after the
// response; the page also refetches when it regains focus.
const broadcast = (complaint, req, kind) => {
  const payload = {
    id: complaint.id, site_id: complaint.site_id, site_name: complaint.site_name, title: complaint.title, complaint_kind: complaint.kind, updated_at: complaint.updated_at,
    status: complaint.status, priority: complaint.priority, raised_by: complaint.raised_by,
    assigned_to: complaint.assigned_to, shared_with: complaint.shared_with || [], actor_id: req.user.id, actor_name: req.authenticatedUser?.name || req.user.name || '', kind,
  };
  complaints.complaintRecipients(complaint.id)
    .then(ids => ids.forEach(id => emitToUser(id, 'complaint:changed', payload)))
    .catch(error => console.error('Complaint push failed:', error.message));
};

const noStore = res => res.set('Cache-Control', 'no-store');

export const listComplaints = asyncHandler(async (req, res) => {
  noStore(res).json({ complaints: await complaints.listComplaints(req.user, req.query) });
});

export const getComplaintPeople = asyncHandler(async (req, res) => {
  noStore(res).json({ people: await complaints.listComplaintPeople(req.user, req.query) });
});

export const getComplaint = asyncHandler(async (req, res) => {
  noStore(res).json(await complaints.listComplaintEvents(req.user, req.params.id));
});

export const createComplaint = asyncHandler(async (req, res) => {
  try {
    const complaint = await complaints.createComplaint(req.user, req.body, undefined, req.files || []);
    broadcast(complaint, req, 'created');
    res.status(201).json({ complaint, message: `Complaint assigned to ${complaint.assigned_to_name}` });
  } finally {
    (req.files || []).forEach(file => cleanupFile(file.path));
  }
});

const STATUS_MESSAGE = { in_progress: 'Marked in progress', resolved: 'Marked resolved', closed: 'Complaint closed', open: 'Complaint reopened' };

export const changeComplaintStatus = asyncHandler(async (req, res) => {
  const complaint = await complaints.changeComplaintStatus(req.user, req.params.id, req.body);
  broadcast(complaint, req, 'status');
  res.json({ complaint, message: STATUS_MESSAGE[complaint.status] });
});

export const shareComplaint = asyncHandler(async (req, res) => {
  const complaint = await complaints.shareComplaint(req.user, req.params.id, req.body);
  broadcast(complaint, req, 'shared');
  const count = complaint.shared_with.length;
  res.json({ complaint, message: count ? `Now shown to ${count} ${count === 1 ? 'person' : 'people'}` : 'No longer shared with anyone else' });
});

export const reassignComplaint = asyncHandler(async (req, res) => {
  const complaint = await complaints.reassignComplaint(req.user, req.params.id, req.body);
  broadcast(complaint, req, 'assigned');
  res.json({ complaint, message: `Reassigned to ${complaint.assigned_to_name}` });
});

export const getComplaintInbox = asyncHandler(async (req, res) => {
  noStore(res).json(await complaints.complaintInbox(req.user, req.query));
});

export const getComplaintComments = asyncHandler(async (req, res) => {
  noStore(res).json(await complaints.listComplaintComments(req.user, req.params.id, req.query));
});

export const createComplaintComment = asyncHandler(async (req, res) => {
  const { comment, created, complaint, ...metadata } = await complaints.createComplaintComment(req.user, req.params.id, req.body);
  if (created) {
    // No text in the push: every recipient fetches the delta through current access checks.
    complaints.complaintRecipients(complaint.id)
      .then(ids => ids.forEach(id => emitToUser(id, 'complaint:comment', {
        id: complaint.id, request_id: complaint.id, site_id: complaint.site_id, comment_id: comment.id, author_id: comment.author_id,
        raised_by: complaint.raised_by, assigned_to: complaint.assigned_to, shared_with: complaint.shared_with || [], kind: complaint.kind,
        comment_count: metadata.comment_count, last_comment_at: metadata.last_comment_at, priority: complaint.priority,
      })))
      .catch(error => console.error('Complaint comment push failed:', error.message));
  }
  noStore(res).status(created ? 201 : 200).json({ comment, ...metadata });
});

export const markComplaintCommentsSeen = asyncHandler(async (req, res) => {
  noStore(res).json(await complaints.markComplaintCommentsSeen(req.user, req.params.id, req.body));
});

export const getComplaintAttachment = asyncHandler(async (req, res) => {
  noStore(res);
  const { id, index } = req.params;
  if (req.query.content === 'preview') return sendRequestAttachment(res, await complaints.complaintAttachmentFile(req.user, id, index));
  res.json(await complaints.complaintAttachmentUrl(req.user, id, index));
});

export const getComplaintAccess = asyncHandler(async (req, res) => {
  noStore(res).json({ users: await complaints.listComplaintAccess(req.user, req.query) });
});

export const updateComplaintAccess = asyncHandler(async (req, res) => {
  const access = await complaints.setComplaintAccess(req.user, req.params.userId, req.body);
  const message = access.scope === 'all' ? 'Can now follow every complaint on this site'
    : access.scope === 'selected' ? `Can now follow own complaints + ${access.user_ids.length} selected ${access.user_ids.length === 1 ? 'person' : 'people'}`
      : 'Can now see own complaints only';
  res.json({ access, message });
});
