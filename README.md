# DocArchive Backend

A robust and scalable multi-tenant SaaS backend for secure document archiving, built with Node.js, Express, MongoDB, and Wasabi cloud storage.

## Features

- **Multi-tenant Architecture**: Complete tenant isolation with separate data for each organization
- **Secure Authentication**: JWT-based auth with bcrypt password hashing and 2FA support
- **Document Management**: Upload, download, version control, and soft delete
- **Collaboration**: Document sharing, comments, reactions, and notifications
- **Cloud Storage**: Integration with Wasabi S3-compatible storage
- **Security**: Rate limiting, input validation, XSS protection, and SQL injection prevention
- **Activity Logging**: Comprehensive audit trail of all user actions
- **Email Notifications**: Transactional emails for account and document events

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js 4.18
- **Database**: MongoDB with Mongoose ODM
- **Storage**: Wasabi (S3-compatible)
- **Authentication**: JWT with speakeasy 2FA
- **Email**: Nodemailer with Pug templates
- **Queue**: Bull with Redis
- **Security**: Helmet, express-rate-limit, joi validation

## Installation

1. Install dependencies:
```bash
npm install
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Update `.env` with your configuration:
   - MongoDB connection string
   - Wasabi credentials
   - JWT secrets
   - Email server details

4. Start the server:

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## Environment Variables

See `.env.example` for all required environment variables.

Key variables:
- `NODE_ENV`: Environment (development/production)
- `PORT`: Server port (default: 5000)
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret for JWT token generation
- `WASABI_ACCESS_KEY_ID`: Wasabi access key
- `WASABI_SECRET_ACCESS_KEY`: Wasabi secret key
- `WASABI_BUCKET`: Wasabi bucket name

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login user
- `POST /api/v1/auth/logout` - Logout user
- `POST /api/v1/auth/forgot-password` - Request password reset
- `PATCH /api/v1/auth/reset-password/:token` - Reset password
- `PATCH /api/v1/auth/change-password` - Change password (authenticated)
- `POST /api/v1/auth/2fa/setup` - Setup 2FA
- `POST /api/v1/auth/2fa/enable` - Enable 2FA
- `POST /api/v1/auth/2fa/disable` - Disable 2FA

### Documents
- `GET /api/v1/documents` - Get all documents
- `POST /api/v1/documents` - Upload document
- `GET /api/v1/documents/:id` - Get document details
- `PATCH /api/v1/documents/:id` - Update document
- `DELETE /api/v1/documents/:id` - Delete document (soft)
- `GET /api/v1/documents/:id/download` - Download document
- `POST /api/v1/documents/:id/share` - Share document
- `GET /api/v1/documents/:id/versions` - Get document versions
- `POST /api/v1/documents/:id/versions/:versionNumber/restore` - Restore version

### Users
- `GET /api/v1/users/profile` - Get current user profile
- `PATCH /api/v1/users/profile` - Update profile
- `GET /api/v1/users/statistics` - Get user statistics
- `GET /api/v1/users/activity` - Get activity log
- `GET /api/v1/users/search` - Search users
- `GET /api/v1/users` - Get all users (admin)
- `GET /api/v1/users/:id` - Get user by ID (admin)
- `PATCH /api/v1/users/:id` - Update user (admin)
- `DELETE /api/v1/users/:id` - Delete user (admin)

### Comments
- `GET /api/v1/comments/document/:documentId` - Get comments for document
- `POST /api/v1/comments/document/:documentId` - Add comment
- `PATCH /api/v1/comments/:commentId` - Update comment
- `DELETE /api/v1/comments/:commentId` - Delete comment
- `POST /api/v1/comments/:commentId/reactions` - Add reaction
- `DELETE /api/v1/comments/:commentId/reactions` - Remove reaction

### Notifications
- `GET /api/v1/notifications` - Get all notifications
- `GET /api/v1/notifications/unread-count` - Get unread count
- `PATCH /api/v1/notifications/:notificationId` - Mark as read
- `PATCH /api/v1/notifications/mark-all-read` - Mark all as read
- `DELETE /api/v1/notifications/:notificationId` - Delete notification

### Files (File Vault)
Requires authentication and an active subscription/trial — same gate as Documents, Audio and Video (see [File Vault](#file-vault) below).
- `GET /api/v1/files` - List the authenticated user's files (`?search=` filters by filename/folder path)
- `POST /api/v1/files/upload` - Upload one or more files (`multipart/form-data`, field name `files`) — any file type, no MIME/extension restriction
- `GET /api/v1/files/:id/download` - Download a file, byte-for-byte identical to what was uploaded
- `DELETE /api/v1/files/:id` - Delete a file (removes the Mongo record and the file on disk)
- `DELETE /api/v1/files` - Bulk delete (`{ "ids": [...] }` in the body, max 5000 per request)

## File Vault

An additive feature, separate from the Document archiving pipeline above (which keeps its own MIME whitelist, image re-encoding, and Wasabi storage — those are unrelated and untouched by this feature).

**Upload flow**: `protect` (JWT auth) → `requireActiveSubscription` (same gate as Documents/Audio/Video — no separate plan) → multer with **no `fileFilter`**, writing straight to `uploads/user_{userId}/{uuid}{originalExtension}` on local disk (`middleware/upload.js` → `uploadPlusFiles`, `controllers/fileController.js`). A `File` document (`models/File.js`) records `userId`, `storedPath`, `originalName`, `mimeType`, `size`, `uploadedAt` for each uploaded file, indexed on `{ userId, uploadedAt }`.

**Integrity guarantee**: uploaded bytes are never parsed, re-encoded, or read as text anywhere in this path. Download streams the file straight off disk with `Content-Type`/`Content-Length` taken from the stored metadata and `Content-Disposition` built from the stored `originalName`, so what comes back is byte-for-byte identical to what was uploaded — verified by `tests/fileIntegrity.test.js` (SHA-256 round-trip). Note the app's global `compression()` middleware would otherwise gzip large downloads and drop the `Content-Length` header it can no longer guarantee; the download route opts out via `res.locals.skipCompression` (see `app.js`).

**Server limits** (all configurable via env, see `.env.example`):
- `PLUS_MAX_FILE_SIZE` — max bytes per file (default `524288000`, 500MB)
- `PLUS_MAX_FILES_PER_UPLOAD` — max files per upload request (default `50`; the frontend uploads one file per request regardless, so this doesn't cap how many files a batch/folder upload can contain — see below)
- `express.json()`/`express.urlencoded()` limits in `app.js` (currently 500MB) don't apply to multipart file bodies, which multer streams directly to disk — only the two vars above bound file size
- If this app sits behind a reverse proxy (e.g. Nginx), its body-size limit must also be raised to match, e.g. `client_max_body_size 500m;` — otherwise the proxy rejects large uploads before they reach Node

**File/folder count**: no limit. The frontend (`PlusFiles.jsx`) sets no `maxFiles` on the dropzone and uploads each file as its own request (for per-file progress/retry), so `PLUS_MAX_FILES_PER_UPLOAD` above never comes into play — a folder with thousands of files queues and uploads them all, three at a time (`CONCURRENCY` in `PlusFiles.jsx`). The only real ceiling is `uploadLimiter`'s shared rate limit (`middleware/rateLimiter.js`, `UPLOAD_LIMIT_MAX_REQUESTS`, default 20,000 requests/hour — same limiter the Document upload feature uses).

**Folder uploads**: both drag-and-drop of a folder and the vault's "Select a folder" button (a `webkitdirectory` file input) are supported. The folder-relative path is captured client-side and sent as `relativePath` (or `relativePaths`, a JSON array, for batched requests) alongside the upload; `models/File.js` stores it separately from `originalName`. It's display-only — storage and download always key off `storedPath`/`_id`, and the saved/downloaded filename is always the plain `originalName`, not the full path.

**Access**: available to any authenticated user with an active subscription/trial — no separate plan or upgrade flow. Previously gated behind a `User.isPlus` flag; that field, its middleware (`middleware/planAccess.js`), and the frontend's upgrade-CTA gate have been removed so the vault is open the same way Documents/Audio/Video already are.

**Bulk delete**: the "My Documents" list (`PlusFiles.jsx`) supports selecting files via checkboxes (including "select all") and deleting them in one request via `DELETE /api/v1/files`. Ownership-scoped and lenient — an id that isn't the caller's file, doesn't exist, or is already gone is skipped rather than failing the whole batch.

## Project Structure

```
backend/
├── src/
│   ├── config/           # Configuration files
│   │   ├── database.js   # MongoDB connection
│   │   └── wasabi.js     # Wasabi S3 config
│   ├── models/           # Mongoose models
│   │   ├── User.js
│   │   ├── Document.js
│   │   ├── Comment.js
│   │   ├── Notification.js
│   │   ├── Tenant.js
│   │   └── ActivityLog.js
│   ├── controllers/      # Route controllers
│   │   ├── authController.js
│   │   ├── documentController.js
│   │   ├── userController.js
│   │   ├── commentController.js
│   │   └── notificationController.js
│   ├── routes/           # API routes
│   │   ├── auth.routes.js
│   │   ├── document.routes.js
│   │   ├── user.routes.js
│   │   ├── comment.routes.js
│   │   └── notification.routes.js
│   ├── middleware/       # Express middleware
│   │   ├── auth.js
│   │   ├── upload.js
│   │   ├── validator.js
│   │   ├── rateLimiter.js
│   │   ├── errorHandler.js
│   │   └── activityLogger.js
│   ├── services/         # Business logic
│   │   └── emailService.js
│   ├── utils/            # Utility functions
│   │   ├── catchAsync.js
│   │   └── appError.js
│   ├── templates/        # Email templates
│   │   └── emails/
│   ├── app.js            # Express app setup
│   └── server.js         # Server entry point
├── .env.example          # Environment variables template
├── package.json
└── README.md
```

## Security Features

- JWT authentication with refresh tokens
- Password hashing with bcrypt (12 rounds)
- Two-factor authentication (TOTP)
- Rate limiting on all endpoints
- Input validation with Joi schemas
- XSS protection
- NoSQL injection prevention
- HTTP parameter pollution prevention
- Helmet security headers
- CORS configuration
- Account lockout after failed login attempts
- Activity logging for audit trails

## Multi-Tenancy

The application implements a multi-tenant architecture where:
- Each tenant (organization) has isolated data
- All database queries are filtered by `tenantId`
- Users can only access resources within their tenant
- Tenant ID is extracted from authenticated user's JWT token
- Admins can only manage users within their tenant

## Error Handling

The application uses a centralized error handling approach:
- Operational errors are caught and returned with appropriate status codes
- Programming errors are logged and return generic error messages
- All async route handlers use the `catchAsync` wrapper
- Custom `AppError` class for operational errors

## Development

Run in development mode with auto-reload:
```bash
npm run dev
```

Lint code:
```bash
npm run lint
```

Run tests:
```bash
npm test
```

## License

ISC
