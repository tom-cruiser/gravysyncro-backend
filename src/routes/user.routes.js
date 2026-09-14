const express = require('express');
const userController = require('../controllers/userController');
const { protect, restrictTo } = require('../middleware/auth');
const { validate } = require('../middleware/validator');

const router = express.Router();

// All routes require authentication
router.use(protect);

// Current user routes
router.get('/profile', userController.getProfile);
router.patch('/profile', validate('updateProfile'), userController.updateProfile);
router.patch('/preferences', userController.updatePreferences);
router.get('/activity', userController.getUserActivity);
router.get('/statistics', userController.getUserStats);

// Subscription / storage plan (self-service, affects the whole tenant)
router.get('/subscription-plans', userController.getSubscriptionPlans);
router.patch('/subscription-plan', userController.updateSubscriptionPlan);
router.get('/subscription-plan/request', userController.getPendingPlanRequest);

// Search users
router.get('/search', userController.searchUsers);

// Admin only routes
router.use(restrictTo('admin'));

router.get('/', userController.getAllUsers);
router.get('/:id', userController.getUser);
router.patch('/:id', userController.updateUser);
router.delete('/:id', userController.deleteUser);
router.get('/:id/activity', userController.getUserActivity);
router.get('/:id/statistics', userController.getUserStats);

module.exports = router;
