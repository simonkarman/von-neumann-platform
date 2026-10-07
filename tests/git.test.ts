import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Keep a recoverable isolated fixture outside the user's running application state.
process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'von-neumann-git-test-'));
process.env.RUNTIME_DRIVER = 'process';
process.env.DASHBOARD_REPO_URL = '';
process.env.DASHBOARD_TEMPLATE_DIR = path.resolve('dashboard-base');
const { store } = await import('../server/store.js');
const { prepareWorkspace, commitDashboard, git, history, restoreRevision, retrySync } = await import('../server/git.js');
const { dashboardSchema } = await import('../server/schema.js');

test('Git persists branches, rolls back invalid code, retries failed pushes, and restores from a fresh clone', async () => {
  const session = store.create();
  let dir = await prepareWorkspace(session.id);
  await symlink(path.resolve('dashboard-base/node_modules'), path.join(dir, 'node_modules'), 'dir');
  const initial = store.get(session.id)!;
  const spec = dashboardSchema.parse({ title: 'Portable dashboard', widgets: [{ id: 'note', type: 'text', title: 'A note', content: 'Portable configuration' }] });
  const committed = await commitDashboard(session.id, spec, 'Add note');
  assert.notEqual(committed.revision, initial.revision);
  assert.equal(await git(dir, 'branch', '--show-current'), `session/${session.id}`);
  assert.equal(committed.syncStatus, 'local');

  const source = path.join(dir, 'src/generated/Dashboard.tsx');
  const renderer = path.join(dir, 'src/components/widgets.tsx');
  const oldRenderer = await readFile(renderer, 'utf8'), oldSource = await readFile(source, 'utf8');
  await writeFile(renderer, 'this is deliberately invalid TypeScript');
  await assert.rejects(commitDashboard(session.id, { ...spec, title: 'Rejected' }, 'Should fail'), /rolled back/);
  assert.equal(await readFile(source, 'utf8'), oldSource);
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), committed.revision);
  await writeFile(renderer, oldRenderer);

  const remote = await git(dir, 'remote', 'get-url', 'origin');
  await git(dir, 'remote', 'set-url', '--push', 'origin', path.join(process.env.DATA_DIR!, 'missing-remote.git'));
  const pending = await commitDashboard(session.id, { ...spec, title: 'Pending sync' }, 'Offline commit');
  assert.equal(pending.syncStatus, 'pending');
  await prepareWorkspace(session.id);
  assert.equal(store.get(session.id)!.syncStatus, 'pending', 'restart preserves unsynced status');
  await git(dir, 'remote', 'set-url', '--push', 'origin', remote);
  await retrySync(session.id);
  assert.equal(store.get(session.id)!.syncStatus, 'local');

  await rename(dir, dir + '-archived');
  dir = await prepareWorkspace(session.id, true);
  await symlink(path.resolve('dashboard-base/node_modules'), path.join(dir, 'node_modules'), 'dir');
  assert.equal(store.get(session.id)!.dashboard.title, 'Pending sync');
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), pending.revision);
  const restored = await restoreRevision(session.id, initial.revision!);
  assert.notEqual(restored.revision, initial.revision, 'restore preserves history as a new commit');
  assert.equal(store.get(session.id)!.dashboard.widgets.length, 0);
  assert.ok((await history(session.id)).length >= 4);
});
