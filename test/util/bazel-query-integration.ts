// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {describe, it, before, after} from 'mocha';
import {expect} from 'chai';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {resolveBazelQuery, runBazelQuery} from '../../src/util/bazel-query';
import {CommitSplit} from '../../src/util/commit-split';

// Run explicitly in CI with a pinned Bazel version; unit tests need no Bazel install.
const integration =
  process.env.BAZEL_INTEGRATION_TEST === '1' ? describe : describe.skip;
integration('Bazel workspace integration', function () {
  this.timeout(180000);
  let workspace: string;
  let originalDirectory: string;

  before(() => {
    originalDirectory = process.cwd();
    workspace = mkdtempSync(join(tmpdir(), 'release-please-bazel-workspace-'));
    mkdirSync(join(workspace, 'apps/app'), {recursive: true});
    mkdirSync(join(workspace, 'libs/shared'), {recursive: true});
    mkdirSync(join(workspace, 'shared'));
    writeFileSync(join(workspace, '.bazelversion'), '7.6.1\n');
    writeFileSync(
      join(workspace, '.bazelrc'),
      [
        'startup --batch',
        `startup --output_user_root=${join(workspace, 'cache')}`,
        'common --enable_bzlmod=false',
        'query --noshow_progress',
      ].join('\n')
    );
    writeFileSync(join(workspace, 'WORKSPACE'), '');
    writeFileSync(
      join(workspace, 'BUILD.bazel'),
      'exports_files(["config.json", "shared/config.json"])\n'
    );
    writeFileSync(join(workspace, 'config.json'), '{}');
    writeFileSync(join(workspace, 'shared/config.json'), '{}');
    writeFileSync(join(workspace, 'libs/shared/source.txt'), 'shared source');
    writeFileSync(
      join(workspace, 'libs/shared/BUILD.bazel'),
      'filegroup(name="shared", srcs=["source.txt"], visibility=["//visibility:public"])\n'
    );
    writeFileSync(
      join(workspace, 'apps/app/BUILD.bazel'),
      'filegroup(name="app", srcs=["//libs/shared", "//:config.json", "//:shared/config.json"])\n'
    );
    process.chdir(workspace);
  });

  after(() => {
    process.chdir(originalDirectory);
    rmSync(workspace, {recursive: true, force: true});
  });

  it('resolves real labels and selects only commits affecting dependencies', () => {
    const paths = runBazelQuery(
      resolveBazelQuery(true, 'apps/app'),
      'apps/app'
    );
    expect(paths).to.deep.equal([
      'config.json',
      'libs/shared',
      'shared/config.json',
    ]);
    const commits = [
      'config.json',
      'shared/config.json',
      'libs/shared/source.txt',
      'unrelated.txt',
      'shared/unrelated.json',
    ].map(file => ({sha: file, message: 'fix: dependency', files: [file]}));
    const split = new CommitSplit({packagePaths: {'apps/app': paths}}).split(
      commits
    );
    expect(split['apps/app']).to.deep.equal(commits.slice(0, 3));
  });

  it('propagates a real Bazel query error', () => {
    expect(() => runBazelQuery('deps(//apps/app:missing)')).to.throw(
      'Failed to execute bazel-deps-query "deps(//apps/app:missing)"'
    );
  });
});
