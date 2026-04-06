const path = require('path');

const migration = process.argv[2];

const migrations = {
  'workspace-members': 'backfillWorkspaceMembers.js',
};

if (!migration || !migrations[migration]) {
  const supported = Object.keys(migrations).join(', ');
  console.error(`Usage: node src/scripts/migrate.js <migration-name> [args]\nSupported migrations: ${supported}`);
  process.exit(1);
}

require(path.resolve(__dirname, migrations[migration]));
