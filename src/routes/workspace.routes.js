const express = require('express');
const workspaceController = require('../controllers/workspaceController');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validator');

const router = express.Router();

router.use(protect);

router.get('/', workspaceController.getWorkspaces);
router.get('/terminology', workspaceController.getTerminology);
router.patch('/terminology', validate('updateTerminology'), workspaceController.updateTerminology);
router.get('/settings/branding', workspaceController.getBrandingSettings);
router.patch('/settings/branding', validate('updateBrandingSettings'), workspaceController.updateBrandingSettings);
router.post('/', validate('createWorkspace'), workspaceController.createWorkspace);
router.get('/:workspaceId', workspaceController.getWorkspace);
router.delete('/:workspaceId', workspaceController.deleteWorkspace);
router.post('/:workspaceId/invite', validate('inviteWorkspaceMembers'), workspaceController.inviteMembers);
router.get('/:workspaceId/members', workspaceController.getWorkspaceMembers);
router.post('/:workspaceId/members/internal', validate('addWorkspaceInternalMember'), workspaceController.addInternalMember);
router.post('/:workspaceId/members/guest', validate('addWorkspaceGuestMember'), workspaceController.addGuestMember);
router.patch('/:workspaceId/members/:memberId', validate('updateWorkspaceMemberRole'), workspaceController.updateWorkspaceMemberRole);
router.delete('/:workspaceId/members/:memberId', workspaceController.removeWorkspaceMember);
router.post('/:workspaceId/archive', workspaceController.archiveWorkspace);
router.post('/:workspaceId/rework', workspaceController.toggleRework);

module.exports = router;