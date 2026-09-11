import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const publishWorkflow = readFileSync(
  new URL('../.github/workflows/preview-publish.yml', import.meta.url),
  'utf8'
);
const exposeArtifactAction = readFileSync(
  new URL('../.github/actions/expose-artifact-on-public-url/action.yml', import.meta.url),
  'utf8'
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('wrong-trigger misuse fails in the guard step, not at job level', () => {
  assert.doesNotMatch(
    publishWorkflow,
    /^\s*if:\s*github\.event_name\s*==\s*'workflow_run'\s*$/m
  );
  assert.match(
    publishWorkflow,
    /if \[ "\$EVENT_NAME" != "workflow_run" \]; then[\s\S]*?exit 1/
  );
  assert.match(
    readme,
    /Non-PR source runs and failed build runs\s+skip intentionally/
  );
});

test('publish workflow validates the untrusted artifact name against workflow_run metadata', () => {
  assert.match(
    publishWorkflow,
    /const artifacts = list\.data\.artifacts\.filter/
  );
  assert.match(publishWorkflow, /artifacts\.length !== 1/);
  assert.match(publishWorkflow, /context\.payload\.workflow_run\.head_sha/);
  assert.match(publishWorkflow, /commitSha !== expectedSha/);
  assert.match(publishWorkflow, /github\.rest\.pulls\.get/);
  assert.match(publishWorkflow, /pull_number: Number\(prNumber\)/);
  assert.match(publishWorkflow, /prResponse\.data\.head\.sha !== expectedSha/);
});

test('publish workflow rejects link entries before extracting a bundle', () => {
  const extractStep = publishWorkflow.match(
    /- name: Extract artifact bundle[\s\S]*?python3 <<'PY'\n([\s\S]*?)\n\s+PY/
  );
  assert.ok(extractStep, 'Extract artifact bundle step not found');
  const extractScript = extractStep[1].replace(/^ {10}/gm, '');
  const directory = mkdtempSync(join(tmpdir(), 'preview-bundle-'));

  try {
    const fixture = spawnSync('python3', ['-c', `
from zipfile import ZipFile, ZipInfo

entry = ZipInfo('zips/preview.zip')
entry.create_system = 3
entry.external_attr = 0o120777 << 16
with ZipFile('bundle.zip', 'w') as archive:
    archive.writestr(entry, '/tmp/outside.zip')
`], { cwd: directory, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);

    const result = spawnSync('python3', ['-c', extractScript], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a regular file or directory/);
    assert.equal(existsSync(join(directory, 'bundle')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publish workflow stages bundle files before the token-bearing upload step', () => {
  const prepareStep = publishWorkflow.match(
    /- name: Prepare release assets[\s\S]*?(?=\n\s+- name: Ensure release exists)/
  )?.[0];
  const uploadStep = publishWorkflow.match(
    /- name: Upload zips and resolve URLs[\s\S]*?(?=\n\s+- name: Render blueprint)/
  )?.[0];
  assert.ok(prepareStep, 'Prepare release assets step not found');
  assert.ok(uploadStep, 'Upload zips and resolve URLs step not found');
  assert.doesNotMatch(prepareStep, /GH_TOKEN/);
  assert.match(prepareStep, /cp -- "\$src" "release-assets\/\$asset"/);
  assert.match(uploadStep, /GH_TOKEN/);
  assert.match(uploadStep, /staged="release-assets\/\$asset"/);
  assert.doesNotMatch(uploadStep, /bundle\/zips/);
});

test('release cleanup failures fail the workflow instead of being swallowed', () => {
  assert.match(publishWorkflow, /delete_errors=0/);
  assert.match(
    publishWorkflow,
    /if ! gh release delete-asset "\$RELEASE_TAG" "\$asset"/
  );
  assert.match(
    publishWorkflow,
    /::error::Failed to delete release asset: \$asset/
  );
  assert.match(
    publishWorkflow,
    /if \[ "\$delete_errors" -ne 0 \]; then\s+exit 1\s+fi/
  );

  const cleanupBlock = publishWorkflow.match(
    /- name: Cleanup old artifacts[\s\S]*?- name: Post Playground preview button/
  )?.[0];
  assert.ok(cleanupBlock, 'Cleanup step not found');
  assert.doesNotMatch(cleanupBlock, /delete-asset[\s\S]*\|\| true/);
});

test('publish workflow validates release retention before uploading assets', () => {
  assert.match(
    publishWorkflow,
    /artifacts-to-keep must be a positive integer or 'keep-all'/
  );
  assert.match(publishWorkflow, /\[\[ "\$ARTIFACTS_TO_KEEP" =~ \^\[0-9\]\+\$ \]\]/);
  assert.match(publishWorkflow, /\[ "\$ARTIFACTS_TO_KEEP" -lt 1 \]/);
});


test('cleanup sorts release assets by the GitHub CLI createdAt field', () => {
  assert.doesNotMatch(publishWorkflow, /created_at/);
  assert.match(publishWorkflow, /createdAt/);
  assert.doesNotMatch(exposeArtifactAction, /created_at/);
  assert.match(exposeArtifactAction, /createdAt/);
});

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
