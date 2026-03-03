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

import {execFileSync} from 'child_process';
import {Logger} from './logger';

/**
 * Parse the output of a bazel query command into a list of local package paths.
 *
 * Bazel query output contains lines like:
 *   //path/to/package:target_name
 *   @external_dep//path:target
 *
 * This function:
 * 1. Filters out external dependencies (lines starting with `@`)
 * 2. Extracts the package path from local targets (`//path/to/package:target` -> `path/to/package`)
 * 3. Deduplicates paths
 * 4. Optionally excludes a given path (e.g., the package's own path)
 *
 * @param output Raw stdout from a bazel query command
 * @param excludePath Optional path to exclude from results (e.g., the package's own path)
 * @returns Array of unique local package paths
 */
export function parseBazelQueryOutput(
  output: string,
  excludePath?: string
): string[] {
  const lines = output.split('\n').filter(line => line.trim().length > 0);

  const paths = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip external dependencies (start with @)
    if (trimmed.startsWith('@')) {
      continue;
    }

    // Match local targets: //path/to/package:target or //path/to/package
    const match = trimmed.match(/^\/\/([^:]*)/);
    if (!match) {
      continue;
    }

    const packagePath = match[1];

    // Skip empty paths (e.g., //:target refers to the root)
    if (!packagePath) {
      continue;
    }

    // Normalize: remove trailing slashes
    const normalized = packagePath.replace(/\/+$/, '');
    if (!normalized) {
      continue;
    }

    // Exclude the package's own path if specified
    if (excludePath && normalized === excludePath.replace(/\/+$/, '')) {
      continue;
    }

    paths.add(normalized);
  }

  return Array.from(paths).sort();
}

/**
 * Build the default bazel query expression for a given package path.
 *
 * @param packagePath The package path (e.g., "apps/my-app")
 * @returns The bazel query expression (passed to `bazel query`)
 */
export function buildBazelQueryExpression(packagePath: string): string {
  return `deps(//${packagePath})`;
}

/**
 * Resolve the bazel query expression from the config value.
 *
 * - If the config value is `true`, build the default expression from the package path.
 * - If the config value is a string:
 *    - If it starts with `bazel query`, treat it as a full command and extract the query expression
 *    - Otherwise, treat it as a query expression directly
 *
 * @param configValue The `bazel-deps-query` config value (boolean or string)
 * @param packagePath The package path from the config key
 * @returns The resolved bazel query expression
 */
export function resolveBazelQuery(
  configValue: boolean | string,
  packagePath: string
): string {
  if (configValue === true) {
    return buildBazelQueryExpression(packagePath);
  }

  // A boolean `false` behaves like "disabled".
  if (configValue === false) {
    return '';
  }

  const trimmed = configValue.trim();
  const bazelQueryPrefix = /^bazel\s+query\s+/;
  if (bazelQueryPrefix.test(trimmed)) {
    let expr = trimmed.replace(bazelQueryPrefix, '').trim();
    // If the expression is quoted, strip surrounding quotes.
    if (
      (expr.startsWith('"') && expr.endsWith('"')) ||
      (expr.startsWith("'") && expr.endsWith("'"))
    ) {
      expr = expr.slice(1, -1);
    }
    return expr;
  }

  return trimmed;
}

/**
 * Execute a bazel query expression and return the parsed local package paths.
 *
 * This uses `execFileSync` (no shell) to reduce the risk of command injection.
 *
 * @param queryExpression The query expression to execute (e.g., "deps(//combined-service)")
 * @param excludePath Optional path to exclude from results
 * @param logger Optional logger instance
 * @returns Array of unique local package paths
 */
export function runBazelQuery(
  queryExpression: string,
  excludePath?: string,
  logger?: Logger
): string[] {
  logger?.debug(`Running bazel deps query: bazel query '${queryExpression}'`);

  try {
    const output = execFileSync('bazel', ['query', queryExpression], {
      encoding: 'utf-8',
      timeout: 120000, // 2 minute timeout
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const paths = parseBazelQueryOutput(output, excludePath);
    logger?.debug(
      `Bazel deps query resolved ${
        paths.length
      } additional paths: ${JSON.stringify(paths)}`
    );
    return paths;
  } catch (err) {
    const error = err as Error & {stderr?: string};
    logger?.error(
      `Failed to run bazel deps query "${queryExpression}": ${error.message}`
    );
    if (error.stderr) {
      logger?.error(`stderr: ${error.stderr}`);
    }
    throw new Error(
      `Failed to execute bazel-deps-query "${queryExpression}": ${error.message}`
    );
  }
}
