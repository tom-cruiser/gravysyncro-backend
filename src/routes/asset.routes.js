const express = require('express');
const assetController = require('../controllers/assetController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.patch('/:type/:id/state', assetController.updateAssetLifecycleState);
router.get('/report', assetController.getWorkspaceAssetReport);
router.get('/report/export', assetController.exportWorkspaceAssetReport);

module.exports = router;