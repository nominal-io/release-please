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

import {describe, it, afterEach} from 'mocha';
import * as childProcess from 'child_process';
import * as sinon from 'sinon';
import {expect} from 'chai';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {delimiter, join} from 'path';
import {
  parseBazelQueryOutput,
  resolveBazelQuery,
  runBazelQuery,
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

  it('ignores malformed output and normalizes trailing package slashes', () => {
    expect(
      parseBazelQueryOutput('not a label\n//\n///\n//libs/shared/:target')
    ).to.deep.equal(['libs/shared']);
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

  it('should preserve root-package dependency paths', () => {
    const output = [
      '//:config.json',
      '//:shared/config.json',
      '//libs/my-lib:my-lib',
    ].join('\n');

    const paths = parseBazelQueryOutput(output);
    expect(paths).to.deep.equal([
      'config.json',
      'libs/my-lib',
      'shared/config.json',
    ]);
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
  it('disables queries when configured false', () => {
    expect(resolveBazelQuery(false, 'apps/app')).to.equal('');
  });

  for (const command of [
    '  bazel query "deps(//apps/app)"  ',
    'bazel query deps(//apps/app)',
    '  deps(//apps/app)  ',
  ]) {
    it(`resolves ${command}`, () => {
      expect(resolveBazelQuery(command, 'apps/app')).to.equal(
        'deps(//apps/app)'
      );
    });
  }

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

describe('runBazelQuery execution', () => {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  it('executes without a shell and returns only relevant dependency paths', () => {
    const execute = sandbox
      .stub(childProcess, 'execFileSync')
      .returns(
        '//apps/app:app\n//libs/shared:shared\n//libs/shared:source\n@external//:dep\n//:config.json\n'
      );
    const logger = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
      trace: sandbox.stub(),
    };
    expect(runBazelQuery('deps(//apps/app)', 'apps/app', logger)).to.deep.equal(
      ['config.json', 'libs/shared']
    );
    sinon.assert.calledOnceWithMatch(
      execute,
      'bazel',
      sinon.match(
        (args: string[]) =>
          args.length === 2 &&
          args[0] === 'query' &&
          args[1].includes('deps(//apps/app)')
      ),
      {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    expect(execute.firstCall.args[2]).not.to.have.property('shell', true);
    sinon.assert.calledWithMatch(logger.info, 'additional paths');
  });

  it('returns no paths for an empty query result without a logger', () => {
    sandbox.stub(childProcess, 'execFileSync').returns('');
    expect(runBazelQuery('deps(//apps/app)')).to.deep.equal([]);
  });

  for (const failure of [
    {name: 'missing Bazel', message: 'spawnSync bazel ENOENT', code: 'ENOENT'},
    {name: 'timeout', message: 'spawnSync bazel ETIMEDOUT', code: 'ETIMEDOUT'},
    {
      name: 'nonzero exit',
      message: 'Command failed: bazel query',
      stderr: 'ERROR: no such target',
    },
  ]) {
    it(`propagates ${failure.name} with query context and logs diagnostics`, () => {
      const error = Object.assign(new Error(failure.message), failure);
      sandbox.stub(childProcess, 'execFileSync').throws(error);
      const logger = {
        info: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub(),
        debug: sandbox.stub(),
        trace: sandbox.stub(),
      };
      expect(() =>
        runBazelQuery('deps(//apps/app)', undefined, logger)
      ).to.throw(
        `Failed to execute bazel-deps-query "deps(//apps/app)": ${failure.message}`
      );
      sinon.assert.calledWithMatch(logger.error, failure.message);
      if (failure.stderr) {
        sinon.assert.calledWithExactly(
          logger.error,
          `stderr: ${failure.stderr}`
        );
      } else {
        sinon.assert.calledOnce(logger.error);
      }
    });
  }

  it('propagates errors without requiring a logger', () => {
    sandbox
      .stub(childProcess, 'execFileSync')
      .throws(new Error('query failed'));
    expect(() => runBazelQuery('deps(//apps/app)')).to.throw('query failed');
  });
});

describe('runBazelQuery', () => {
  it('handles output larger than Node’s default process buffer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-please-bazel-'));
    const bazel = join(directory, 'bazel');
    const expectedQuery = "filter('^//', deps(//apps/my-app))";
    writeFileSync(
      bazel,
      `#!${process.execPath}\nif (process.argv[3] !== ${JSON.stringify(
        expectedQuery
      )}) process.exit(2);\nprocess.stdout.write('//libs/my-lib:target\\n'.repeat(70000));\n`
    );
    chmodSync(bazel, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}${delimiter}${originalPath || ''}`;
    try {
      expect(runBazelQuery('deps(//apps/my-app)')).to.deep.equal([
        'libs/my-lib',
      ]);
    } finally {
      process.env.PATH = originalPath;
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
