#!/usr/bin/env node

/**
 * Seed an invite code and test user for E2E tests.
 * Run this against the running dev backend (localhost:3001).
 */

import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { hashPassword } from '../apps/backend/src/middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const INVITE_CODE = 'e2e-test-invite-1234';
const TEST_USER_EMAIL = 'e2e-test@test.dev';
const TEST_USER_PASSWORD = 'password123';

async function main() {
  const db = createDatabase();
  await db.init();

  // Create invite
  const invite = {
    id: INVITE_CODE,
    code: INVITE_CODE,
    createdBy: 'seed-script',
    createdAt: new Date().toISOString(),
  };
  await db.saveInvite(invite);
  console.log(`[seed] Created invite: ${INVITE_CODE}`);

  // Check if user exists
  const existing = await db.getUserByEmail(TEST_USER_EMAIL);
  if (existing) {
    console.log(`[seed] User ${TEST_USER_EMAIL} already exists`);
    return;
  }

  // Create test user
  const userId = uuidv4();
  const passHash = await hashPassword(TEST_USER_PASSWORD);
  const user = {
    id: userId,
    email: TEST_USER_EMAIL,
    passwordHash: passHash,
    twoFactorEnabled: false,
    emailVerified: true,
    createdAt: new Date().toISOString(),
  };
  await db.saveUser(user);
  console.log(`[seed] Created test user: ${TEST_USER_EMAIL} (${userId})`);

  await db.close();
  console.log('[seed] Done');
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});