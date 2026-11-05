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
import * as assert from 'assert';
import * as sinon from 'sinon';
import {expect} from 'chai';
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

  type ExecFileCallback = (
    error: Error | null,
    stdout: string,
    stderr: string
  ) => void;
  // Stubs execFile so each call answers with the next outcome in order.
  function stubExecFile(
    ...outcomes: Array<{stdout: string} | {error: Error & {stderr?: string}}>
  ) {
    let call = 0;
    return sandbox.stub(childProcess, 'execFile').callsFake(((
      _file: string,
      _args: string[],
      _options: object,
      callback: ExecFileCallback
    ) => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
      if ('error' in outcome) {
        callback(outcome.error, '', outcome.error.stderr ?? '');
      } else {
        callback(null, outcome.stdout, '');
      }
      return {} as childProcess.ChildProcess;
    }) as unknown as typeof childProcess.execFile);
  }

  function stubLogger() {
    return {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
      trace: sandbox.stub(),
    };
  }

  it('executes without a shell and returns only relevant dependency paths', async () => {
    const execute = stubExecFile({
      stdout:
        '//apps/app:app\n//libs/shared:shared\n//libs/shared:source\n@external//:dep\n//:config.json\n',
    });
    const logger = stubLogger();
    expect(
      await runBazelQuery('deps(//apps/app)', 'apps/app', logger)
    ).to.deep.equal(['config.json', 'libs/shared']);
    sinon.assert.calledOnceWithMatch(
      execute,
      'bazel',
      sinon.match(
        (args: string[]) =>
          args.length === 2 &&
          args[0] === 'query' &&
          args[1].includes('deps(//apps/app)')
      ),
      {encoding: 'utf-8', timeout: 120000}
    );
    expect(execute.firstCall.args[2]).not.to.have.property('shell', true);
    sinon.assert.calledWithMatch(logger.info, 'additional paths');
  });

  it('handles output larger than the default process buffer', async () => {
    const execute = childProcess.execFile;
    sandbox.stub(childProcess, 'execFile').callsFake(((
      file: string,
      args: string[],
      options: object,
      callback: ExecFileCallback
    ) => {
      expect(file).to.equal('bazel');
      expect(args).to.deep.equal([
        'query',
        "filter('^//', deps(//apps/my-app))",
      ]);
      // Use a real child process without requiring a platform-specific executable.
      return execute(
        process.execPath,
        [
          '-e',
          "process.stdout.write('//libs/my-lib:target\\n'.repeat(70000));",
        ],
        options,
        callback
      );
    }) as unknown as typeof childProcess.execFile);
    expect(await runBazelQuery('deps(//apps/my-app)')).to.deep.equal([
      'libs/my-lib',
    ]);
  });

  it('returns no paths for an empty query result without a logger', async () => {
    stubExecFile({stdout: ''});
    expect(await runBazelQuery('deps(//apps/app)')).to.deep.equal([]);
  });

  for (const failure of [
    {name: 'missing Bazel', message: 'spawn bazel ENOENT', code: 'ENOENT'},
    {
      name: 'timeout',
      message: 'Command failed: bazel query',
      killed: true,
      signal: 'SIGTERM',
    },
    {
      name: 'nonzero exit',
      message: 'Command failed: bazel query',
      stderr: 'ERROR: no such target',
    },
  ]) {
    it(`propagates ${failure.name} with query context and logs diagnostics`, async () => {
      const error = Object.assign(new Error(failure.message), failure);
      stubExecFile({error});
      const logger = stubLogger();
      await assert.rejects(
        runBazelQuery('deps(//apps/app)', undefined, logger),
        {
          message: `Failed to execute bazel-deps-query "deps(//apps/app)": ${failure.message}`,
        }
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

  const fetchFailure = () =>
    Object.assign(new Error('Command failed: bazel query'), {
      stderr:
        "ERROR: An error occurred during the fetch of repository 'rules_android+':\n" +
        'Error in download_and_extract: java.io.IOException: Error downloading ' +
        '[https://github.com/bazelbuild/rules_android/releases/download/v0.7.1/rules_android-v0.7.1.tar.gz]: ' +
        'GET returned 504 Gateway Time-out',
    });

  it('retries a query that failed to fetch an external repository', async () => {
    const execute = stubExecFile(
      {error: fetchFailure()},
      {stdout: '//libs/shared:shared\n'}
    );
    const logger = stubLogger();
    expect(
      await runBazelQuery('deps(//apps/app)', 'apps/app', logger, {
        retryDelayMs: 0,
      })
    ).to.deep.equal(['libs/shared']);
    sinon.assert.calledTwice(execute);
    sinon.assert.calledWithMatch(logger.warn, 'attempt 2 of 3');
  });

  it('gives up after the configured number of fetch failures', async () => {
    const execute = stubExecFile({error: fetchFailure()});
    await assert.rejects(
      runBazelQuery('deps(//apps/app)', undefined, undefined, {
        attempts: 3,
        retryDelayMs: 0,
      }),
      /Failed to execute bazel-deps-query "deps\(\/\/apps\/app\)"/
    );
    sinon.assert.calledThrice(execute);
  });

  it('does not retry failures other than repository fetches', async () => {
    const execute = stubExecFile({
      error: Object.assign(new Error('Command failed: bazel query'), {
        stderr: 'ERROR: no such target',
      }),
    });
    await assert.rejects(
      runBazelQuery('deps(//apps/app)', undefined, undefined, {
        retryDelayMs: 0,
      }),
      /Failed to execute bazel-deps-query/
    );
    sinon.assert.calledOnce(execute);
  });

  it('passes the abort signal to bazel and does not retry once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      stderr: 'Error downloading [https://example.com/repo.tar.gz]',
    });
    const execute = stubExecFile({error: abortError});
    const logger = stubLogger();
    await assert.rejects(
      runBazelQuery('deps(//apps/app)', undefined, logger, {
        retryDelayMs: 0,
        signal: controller.signal,
      }),
      error => error === abortError
    );
    sinon.assert.calledOnce(execute);
    expect(execute.firstCall.args[2]).to.have.property(
      'signal',
      controller.signal
    );
    sinon.assert.notCalled(logger.error);
  });

  it('propagates errors without requiring a logger', async () => {
    stubExecFile({error: new Error('query failed')});
    await assert.rejects(runBazelQuery('deps(//apps/app)'), /query failed/);
  });
});
