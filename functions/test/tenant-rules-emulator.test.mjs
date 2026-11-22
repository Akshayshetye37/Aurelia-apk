import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { ref, uploadString, getBytes, deleteObject } from 'firebase/storage';

const projectId = 'demo-aurelia-primary-auth';
const env = await initializeTestEnvironment({
  projectId,
  firestore: { host: '127.0.0.1', port: 8080, rules: fs.readFileSync('../firestore.rules', 'utf8') },
  storage: { host: '127.0.0.1', port: 9199, rules: fs.readFileSync('../storage.rules', 'utf8') }
});
const ownerA = 'owner-a-test';
const ownerB = 'owner-b-test';
const uidA = 'member-a-test';
const uidB = 'member-b-test';

test('Firestore owner A/B read, write and delete isolation', async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'owners/' + ownerA), { ownerId: ownerA, status: 'active' });
    await setDoc(doc(db, 'owners/' + ownerB), { ownerId: ownerB, status: 'active' });
    await setDoc(doc(db, 'owners/' + ownerA + '/members/' + uidA), { uid: uidA, ownerId: ownerA, role: 'owner', status: 'active' });
    await setDoc(doc(db, 'owners/' + ownerB + '/members/' + uidB), { uid: uidB, ownerId: ownerB, role: 'owner', status: 'active' });
    await setDoc(doc(db, 'owners/inactive-owner/members/inactive-user'), { uid: 'inactive-user', ownerId: 'inactive-owner', role: 'owner', status: 'inactive' });
    await setDoc(doc(db, 'owners/uid-corrupt/members/uid-corrupt-user'), { uid: 'different-uid', ownerId: 'uid-corrupt', role: 'owner', status: 'active' });
    await setDoc(doc(db, 'owners/owner-corrupt/members/owner-corrupt-user'), { uid: 'owner-corrupt-user', ownerId: 'wrong-owner', role: 'owner', status: 'active' });
    await setDoc(doc(db, 'owners/role-corrupt/members/role-corrupt-user'), { uid: 'role-corrupt-user', ownerId: 'role-corrupt', role: 'superuser', status: 'active' });
    await setDoc(doc(db, 'owners/staff-owner/members/staff-user'), { uid: 'staff-user', ownerId: 'staff-owner', role: 'staff', status: 'active' });
    await setDoc(doc(db, 'owners/manager-owner/members/manager-user'), { uid: 'manager-user', ownerId: 'manager-owner', role: 'manager', status: 'active' });
    await setDoc(doc(db, 'owners/admin-owner/members/admin-user'), { uid: 'admin-user', ownerId: 'admin-owner', role: 'admin', status: 'active' });
    for (const owner of ['inactive-owner','uid-corrupt','owner-corrupt','role-corrupt','staff-owner','manager-owner','admin-owner']) {
      await setDoc(doc(db, 'owners/' + owner + '/data/booking'), { value: owner });
    }
    await setDoc(doc(db, 'owners/' + ownerA + '/data/booking-a'), { value: 'A' });
    await setDoc(doc(db, 'owners/' + ownerB + '/data/booking-b'), { value: 'B' });
  });
  const dbA = env.authenticatedContext(uidA).firestore();
  const dbB = env.authenticatedContext(uidB).firestore();
  const outsider = env.authenticatedContext('outsider-test').firestore();
  const pathA = 'owners/' + ownerA + '/data/booking-a';
  const pathB = 'owners/' + ownerB + '/data/booking-b';
  await assertSucceeds(getDoc(doc(dbA, pathA)));
  await assertFails(getDoc(doc(dbA, pathB)));
  await assertFails(setDoc(doc(dbA, pathA), { value: 'A-updated', ownerId: ownerB }));
  await assertSucceeds(setDoc(doc(dbA, pathA), { value: 'A-updated', ownerId: ownerA }));
  await assertFails(setDoc(doc(dbA, pathB), { value: 'spoof', ownerId: ownerA }));
  await assertFails(deleteDoc(doc(dbA, pathB)));
  await assertSucceeds(deleteDoc(doc(dbA, pathA)));
  await assertFails(getDoc(doc(outsider, pathA)));
  await assertFails(setDoc(doc(dbB, pathA), { value: 'spoof' }));
});

test('Storage owner A/B read, write and delete isolation', async () => {
  const storageA = env.authenticatedContext(uidA).storage();
  const storageB = env.authenticatedContext(uidB).storage();
  const outsider = env.authenticatedContext('outsider-test').storage();
  const pathA = 'owners/' + ownerA + '/attachments/a.txt';
  const pathB = 'owners/' + ownerB + '/attachments/b.txt';
  await assertSucceeds(uploadString(ref(storageA, pathA), 'owner A'));
  await assertSucceeds(uploadString(ref(storageB, pathB), 'owner B'));
  await assertSucceeds(getBytes(ref(storageA, pathA)));
  await assertFails(getBytes(ref(storageA, pathB)));
  await assertFails(uploadString(ref(storageA, pathB), 'spoof'));
  await assertFails(uploadString(ref(storageA, pathA), 'spoof-metadata', 'raw', { customMetadata: { ownerId: ownerB } }));
  await assertFails(deleteObject(ref(storageA, pathB)));
  await assertFails(uploadString(ref(outsider, pathA), 'unauthenticated-owner'));
  await assertSucceeds(deleteObject(ref(storageA, pathA)));
});
test.after(async () => env.cleanup());

test('Firestore denies inactive and integrity-corrupt membership records', async () => {
  const cases = [
    ['inactive-user', 'inactive-owner'],
    ['uid-corrupt-user', 'uid-corrupt'],
    ['owner-corrupt-user', 'owner-corrupt'],
    ['role-corrupt-user', 'role-corrupt']
  ];
  for (const [uid, owner] of cases) {
    const db = env.authenticatedContext(uid).firestore();
    await assertFails(getDoc(doc(db, 'owners/' + owner + '/data/booking')));
    await assertFails(setDoc(doc(db, 'owners/' + owner + '/data/new'), { value: 1 }));
  }
});

test('Firestore preserves actual role matrix: staff read-only, manager/admin can write', async () => {
  const staff = env.authenticatedContext('staff-user').firestore();
  const manager = env.authenticatedContext('manager-user').firestore();
  const admin = env.authenticatedContext('admin-user').firestore();
  await assertSucceeds(getDoc(doc(staff, 'owners/staff-owner/data/booking')));
  await assertFails(setDoc(doc(staff, 'owners/staff-owner/data/new'), { value: 1 }));
  await assertSucceeds(setDoc(doc(manager, 'owners/manager-owner/data/new'), { value: 1 }));
  await assertSucceeds(deleteDoc(doc(manager, 'owners/manager-owner/data/booking')));
  await assertSucceeds(setDoc(doc(admin, 'owners/admin-owner/data/new'), { value: 1 }));
});
