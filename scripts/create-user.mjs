// Create or reset website users directly in MongoDB Atlas.
//
//   npm run create-user -- --username rpf-officer1 --role officer --email officer1@example.com
//   npm run create-user -- --username operator1 --role operator --password "S0me-Long-Password"
//   npm run create-user -- --username rpf-officer1 --reset-password
//
// Needs MONGODB_URI (and optionally MONGODB_DB) in a local .env file or the environment.
// When --password is omitted a strong random password is generated and printed once.

import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { COLLECTIONS, closeDb, getDb } from '../lib/mongodb.js';
import { ROLES, buildUserDocument } from '../lib/auth.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string', default: 'officer' },
    password: { type: 'string' },
    'reset-password': { type: 'boolean', default: false },
  },
});

if (!values.username) {
  console.error('Usage: npm run create-user -- --username <id> [--role admin|officer|operator] [--email <email>] [--password <pw>] [--reset-password]');
  process.exit(1);
}
if (!ROLES.includes(values.role)) {
  console.error(`--role must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

const password = values.password || randomBytes(12).toString('base64url');

try {
  const db = await getDb();
  const users = db.collection(COLLECTIONS.users);
  const doc = await buildUserDocument({ username: values.username, email: values.email, password, role: values.role });

  if (values['reset-password']) {
    const result = await users.updateOne({ username: doc.username }, { $set: { passwordHash: doc.passwordHash, isActive: true } });
    if (result.matchedCount === 0) throw new Error(`User "${doc.username}" not found`);
    console.log(`Password reset for "${doc.username}".`);
  } else {
    await users.insertOne(doc);
    console.log(`Created ${doc.role} "${doc.username}"${doc.email ? ` <${doc.email}>` : ''}.`);
  }
  if (!values.password) console.log(`Generated password: ${password}\n(shown only once - store it safely)`);
} catch (err) {
  console.error(err?.code === 11000 ? 'A user with that username or email already exists.' : `Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
