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

import {describe, it} from 'mocha';
import {expect} from 'chai';
import {
  parseBazelQueryOutput,
  resolveBazelQuery,
} from '../../src/util/bazel-query';

describe('parseBazelQueryOutput', () => {
  it('should parse simple bazel query output', () => {
    const output = [
      '//libs/my-lib:my-lib',
      '//libs/other-lib:other-lib',
      '//apps/my-app:my-app',
    ].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal([
      'apps/my-app',
      'libs/my-lib',
      'libs/other-lib',
    ]);
  });

  it('should filter out external dependencies', () => {
    const output = [
      '//libs/my-lib:my-lib',
      '@maven//:com_google_guava_guava',
      '@npm//:node_modules/lodash',
      '//libs/other-lib:other-lib',
      '@bazel_tools//tools/jdk:toolchain',
    ].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal(['libs/my-lib', 'libs/other-lib']);
  });

  it('should exclude the specified path', () => {
    const output = [
      '//apps/my-app:my-app',
      '//libs/my-lib:my-lib',
      '//libs/other-lib:other-lib',
    ].join('\n');

    const paths = parseBazelQueryOutput(output, 'apps/my-app');
    expect(paths).to.deep.equal(['libs/my-lib', 'libs/other-lib']);
  });

  it('should deduplicate paths from multiple targets in the same package', () => {
    const output = [
      '//libs/my-lib:my-lib',
      '//libs/my-lib:test-lib',
      '//libs/my-lib:utils',
      '//libs/other-lib:other-lib',
    ].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal(['libs/my-lib', 'libs/other-lib']);
  });

  it('should handle targets without explicit target name', () => {
    const output = ['//libs/my-lib', '//libs/other-lib:target'].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal(['libs/my-lib', 'libs/other-lib']);
  });

  it('should handle empty output', () => {
    const paths = parseBazelQueryOutput('');
    expect(paths).to.deep.equal([]);
  });

  it('should handle output with blank lines', () => {
    const output = [
      '',
      '//libs/my-lib:my-lib',
      '',
      '//libs/other-lib:other-lib',
      '',
    ].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal(['libs/my-lib', 'libs/other-lib']);
  });

  it('should skip root-level targets', () => {
    const output = ['//:root-target', '//libs/my-lib:my-lib'].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal(['libs/my-lib']);
  });

  it('should handle deeply nested paths', () => {
    const output = [
      '//services/backend/api/v2:server',
      '//libs/shared/utils/common:helpers',
    ].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal([
      'libs/shared/utils/common',
      'services/backend/api/v2',
    ]);
  });

  it('should handle trailing slashes in exclude path', () => {
    const output = ['//apps/my-app:my-app', '//libs/my-lib:my-lib'].join('\n');

    const paths = parseBazelQueryOutput(output, 'apps/my-app/');
    expect(paths).to.deep.equal(['libs/my-lib']);
  });
});

describe('resolveBazelQuery', () => {
  it('should build default query expression when enabled', () => {
    const expr = resolveBazelQuery(true, 'apps/my-app');
    expect(expr).to.equal('deps(//apps/my-app)');
  });

  it('should treat non-prefixed strings as query expressions', () => {
    const expr = resolveBazelQuery('deps(//combined-service)', 'apps/my-app');
    expect(expr).to.equal('deps(//combined-service)');
  });

  it('should extract expression from full bazel query command', () => {
    const expr = resolveBazelQuery(
      "bazel query 'deps(//apps/my-app)'",
      'apps/my-app'
    );
    expect(expr).to.equal('deps(//apps/my-app)');
  });
});
