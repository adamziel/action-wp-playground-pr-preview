import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

for (const filename of ['plugin.zip', 'build/my plugin.zip']) {
  test(`legacy helper uploads only ${filename} without changing workspace files`, () => {
    withLegacyArtifact([
      { name: 'build/', mode: 0o040755 },
      { name: filename, contents: 'opaque zip bytes\0\u00ff', mode: 0o100644 },
      { name: 'README.md', contents: 'not needed for the release' },
    ], ({ run, env, directory, workspace }) => {
      const download = run('Download build artifact from workflow run');
      assert.equal(download.status, 0, download.stderr);
      assert.equal(readFileSync(join(workspace, 'plugin.zip'), 'utf8'), 'existing workspace zip');
      assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), 'existing readme');
      assert.ok(env.ARTIFACT_DIRECTORY.startsWith(`${env.RUNNER_TEMP}/playground-artifact.`));
      assert.deepEqual(readdirSync(env.ARTIFACT_DIRECTORY).sort(), ['artifact.zip', 'download.zip']);

      const upload = run('Upload artifact to release');
      assert.equal(upload.status, 0, upload.stderr);
      assert.deepEqual(readFileSync(env.TEST_UPLOAD), Buffer.from('opaque zip bytes\0\u00ff'));
      assert.equal(readFileSync(join(workspace, 'plugin.zip'), 'utf8'), 'existing workspace zip');
      assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), 'existing readme');
      assert.deepEqual(readdirSync(workspace).sort(), ['README.md', 'plugin.zip']);
      assert.deepEqual(readFileSync(join(directory, 'upload-args'), 'utf8').trim().split('\n'), [
        'release', 'upload', 'ci-artifacts', `${env.ARTIFACT_DIRECTORY}/pr-17-abc123.zip`,
        '--repo', 'example/releases', '--clobber',
      ]);
      const outputs = readFileSync(env.GITHUB_OUTPUT, 'utf8');
      assert.match(outputs, /artifact-name=pr-17-abc123.zip\n/);
      assert.match(outputs, /artifact-url=https:\/\/github.com\/example\/releases\/releases\/download\/ci-artifacts\/pr-17-abc123.zip\n/);

      assert.equal(run('Remove downloaded artifact files').status, 0);
      assert.equal(existsSync(env.ARTIFACT_DIRECTORY), false);
    }, filename);
  });
}

for (const [label, entry, message] of [
  ['selected symlink', { name: 'plugin.zip', mode: 0o120777, contents: '../outside.zip' }, /regular file or directory/],
  ['parent symlink', { name: 'build', mode: 0o120777, contents: '..' }, /regular file or directory/],
  ['absolute path', { name: '/outside.zip' }, /Invalid artifact path/],
  ['parent path', { name: '../outside.zip' }, /Invalid artifact path/],
  ['nested parent path', { name: 'build/../../outside.zip' }, /Invalid artifact path/],
  ['backslash path', { name: '..\\outside.zip' }, /Invalid artifact path/],
  ['named pipe', { name: 'pipe', mode: 0o010644 }, /regular file or directory/],
  ['device entry', { name: 'device', mode: 0o020644 }, /regular file or directory/],
  ['directory mode on a file', { name: 'other.zip', mode: 0o040755 }, /regular file or directory/],
  ['file mode on a directory', { name: 'build/', mode: 0o100644 }, /regular file or directory/],
  ['duplicate filename', { name: 'plugin.zip' }, /exactly one regular file/],
]) {
  test(`legacy helper rejects ${label} before copying any file`, () => {
    withLegacyArtifact([{ name: 'plugin.zip' }, entry], ({ run, env, workspace }) => {
      const result = run('Download build artifact from workflow run');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.deepEqual(readdirSync(env.ARTIFACT_DIRECTORY), ['download.zip']);
      assert.equal(existsSync(env.TEST_UPLOAD), false);
      assert.deepEqual(readdirSync(workspace).sort(), ['README.md', 'plugin.zip']);
      assert.equal(readFileSync(join(workspace, 'plugin.zip'), 'utf8'), 'existing workspace zip');
      assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), 'existing readme');
      assert.equal(run('Remove downloaded artifact files').status, 0);
      assert.equal(existsSync(env.ARTIFACT_DIRECTORY), false);
    });
  });
}

for (const filename of ['plugin.zip', 'missing.zip', 'build/', '../outside.zip', '/outside.zip']) {
  test(`legacy helper does not use a workspace file when ${filename} is absent from the archive`, () => {
    withLegacyArtifact([{ name: 'build/', mode: 0o040755 }], ({ run, env }) => {
      const result = run('Download build artifact from workflow run');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /exactly one regular file/);
      assert.deepEqual(readdirSync(env.ARTIFACT_DIRECTORY), ['download.zip']);
      assert.equal(existsSync(env.TEST_UPLOAD), false);
    }, filename);
  });
}

for (const source of ['workflow run', 'current run']) {
  for (const type of ['symlink', 'directory', 'missing file']) {
    test(`legacy helper rejects a ${type} at upload time for a ${source}`, () => {
      withLegacyArtifact([{ name: 'plugin.zip' }], ({ run, env, directory, workspace }) => {
        let artifactPath = join(workspace, 'plugin.zip');
        if (source === 'workflow run') {
          const download = run('Download build artifact from workflow run');
          assert.equal(download.status, 0, download.stderr);
          artifactPath = join(env.ARTIFACT_DIRECTORY, 'artifact.zip');
        }
        rmSync(artifactPath);
        if (type === 'symlink') {
          symlinkSync(join(directory, 'outside.zip'), artifactPath);
        } else if (type === 'directory') {
          mkdirSync(artifactPath);
        }

        const upload = run('Upload artifact to release');
        assert.notEqual(upload.status, 0);
        assert.match(upload.stderr, /Artifact must be a regular file/);
        assert.equal(existsSync(env.TEST_UPLOAD), false);
        assert.equal(readFileSync(join(directory, 'outside.zip'), 'utf8'), 'outside bytes');
      });
    });
  }
}

test('legacy helper still uploads a regular file from the current run', () => {
  withLegacyArtifact([], ({ run, env }) => {
    const upload = run('Upload artifact to release');
    assert.equal(upload.status, 0, upload.stderr);
    assert.equal(readFileSync(env.TEST_UPLOAD, 'utf8'), 'existing workspace zip');
  });
});

test('legacy helper cleans up downloaded files even when an earlier step fails', () => {
  assert.match(exposeArtifactAction, /- name: Remove downloaded artifact files\n\s+if: \$\{\{ always\(\) && steps.download-workflow-artifact.outputs.directory != '' \}\}/);
  assert.match(exposeArtifactAction, /ARTIFACT_DIRECTORY: \$\{\{ steps.download-workflow-artifact.outputs.directory \}\}/);
});

function withLegacyArtifact(entries, fn, filename = 'plugin.zip') {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-artifact-'));
  const workspace = join(directory, 'workspace');
  const env = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    RUNNER_TEMP: join(directory, 'runner-temp'),
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: join(directory, 'outputs'),
    GITHUB_REPOSITORY: 'example/source',
    ARTIFACT_SOURCE_REPOSITORY: 'example/source',
    ARTIFACT_SOURCE_RUN_ID: '123',
    ARTIFACT_NAME: 'plugin-build',
    ARTIFACT_FILENAME: filename,
    ARTIFACT_DIRECTORY: '',
    RELEASE_REPOSITORY: 'example/releases',
    RELEASE_TAG: 'ci-artifacts',
    PR_NUMBER: '17',
    COMMIT_SHA: 'abc123',
    TEST_ARCHIVE: join(directory, 'fixture.zip'),
    TEST_UPLOAD: join(directory, 'uploaded.zip'),
    TEST_UPLOAD_ARGS: join(directory, 'upload-args'),
  };

  try {
    for (const path of [workspace, env.RUNNER_TEMP, join(directory, 'bin')]) {
      mkdirSync(path);
    }
    writeFileSync(env.GITHUB_OUTPUT, '');
    writeFileSync(join(workspace, 'plugin.zip'), 'existing workspace zip');
    writeFileSync(join(workspace, 'README.md'), 'existing readme');
    writeFileSync(join(directory, 'outside.zip'), 'outside bytes');
    writeFileSync(join(directory, 'bin', 'gh'), `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"/actions/runs/"* ]]; then
  echo 456
elif [[ "$*" == *"/actions/artifacts/"* ]]; then
  cat "$TEST_ARCHIVE"
elif [ "$1 $2" = "release upload" ]; then
  cp -- "$4" "$TEST_UPLOAD"
  printf '%s\\n' "$@" > "$TEST_UPLOAD_ARGS"
else
  echo "Unexpected gh call: $*" >&2
  exit 1
fi
`, { mode: 0o755 });
    const fixture = spawnSync('python3', ['-c', `
import json
import os
import sys
from zipfile import ZipFile, ZipInfo

with ZipFile(os.environ['TEST_ARCHIVE'], 'w') as archive:
    for item in json.load(sys.stdin):
        entry = ZipInfo(item['name'])
        entry.create_system = 3
        entry.external_attr = item.get('mode', 0o600) << 16
        archive.writestr(entry, item.get('contents', 'zip bytes').encode())
`], { env, input: JSON.stringify(entries), encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);

    const run = (name) => {
      const step = exposeArtifactAction.match(new RegExp(`    - name: ${name}\\n([\\s\\S]*?)(?=\\n    - name: |$)`));
      assert.ok(step, `${name} step not found`);
      const script = step[1].match(/      run: (?:\|\n([\s\S]*)|([^\n]+))/);
      assert.ok(script, `${name} script not found`);
      const result = spawnSync('bash', ['-c', (script[1] ?? script[2]).replace(/^ {8}/gm, '')], {
        cwd: workspace, env, encoding: 'utf8',
      });
      const outputs = readFileSync(env.GITHUB_OUTPUT, 'utf8');
      env.ARTIFACT_DIRECTORY = outputs.match(/^directory=(.+)$/m)?.[1] ?? '';
      return result;
    };
    fn({ run, env, directory, workspace });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
