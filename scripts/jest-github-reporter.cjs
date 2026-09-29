/**
 * A jest reporter that turns each failure into a GitHub Actions annotation.
 *
 * Without it, a red `npm test` in CI is a single "Process completed with exit
 * code 1" and nothing else. The test name, the file and the message are all in
 * the job log, which sits behind a sign-in, so a failure is not diagnosable from
 * the pull request view or from the checks API -- which is the same reason this
 * file exists: without it there is no way to read a CI failure without a
 * browser session.
 *
 * Emitting `::error file=...::` workflow commands puts each failing test on the
 * PR's checks tab, where it belongs.
 *
 * Jest's result shape is read defensively. Jest 30 exposes `testFilePath` and
 * `testResults` on a suite; the shape it replaced exposed `name` and
 * `assertionResults`. Both are handled, because a reporter that throws on the
 * wrong version is worse than one that reports nothing.
 *
 * GitHub caps annotations per step, so the list is sorted to put a suite that
 * never ran ahead of assertion failures inside it: a syntax error or a missing
 * module explains every failure in that file at once.
 */

const MAX_ANNOTATIONS = 10;
const MAX_MESSAGE = 900;

const esc = (value) => String(value ?? '')
  .replace(/%/g, '%25')
  .replace(/\r/g, '%0D')
  .replace(/\n/g, '%0A');

const suites = (results) => (Array.isArray(results && results.testResults) ? results.testResults : []);
const fileOf = (suite) => suite.testFilePath || suite.name || 'unknown';
const casesOf = (suite) => suite.testResults || suite.assertionResults || [];

/** First meaningful line of a jest failure message, without the stack. */
const headline = (message) => {
  const text = esc(message || 'failed');
  const firstBlock = text.split('%0A%0A')[0];
  const line = firstBlock
    .split('%0A')
    .map((l) => l.replace(/\[[0-9;]*m/g, '').trim())
    .find((l) => l && !/^\s*at\s/.test(l));
  return (line || text).slice(0, MAX_MESSAGE);
};

class GitHubReporter {
  constructor(globalConfig, options = {}) {
    this.out = options.out || process.stdout;
    this.enabled = options.enabled !== undefined
      ? options.enabled
      : process.env.GITHUB_ACTIONS === 'true';
  }

  emit(line) {
    this.out.write(line + '\n');
  }

  rel(absolute) {
    const p = String(absolute).replace(/\\/g, '/');
    // GitHub wants a path relative to the repository root. On a runner jest
    // already reports one; locally the checkout is nested (`.../anydb-mcp/preview`),
    // so anything up to the last `anydb-mcp/` goes, and the local leaf name with
    // it, or the annotation would point at a path that does not exist in the repo.
    const at = p.lastIndexOf('anydb-mcp/');
    const trimmed = at === -1 ? p : p.slice(at + 'anydb-mcp/'.length);
    return trimmed.replace(/^preview\//, '');
  }

  onRunComplete(_contexts, results) {
    if (!this.enabled) return;

    const all = suites(results);
    const broken = all.filter((s) => (s.numFailingTests ?? 0) > 0 || (s.testExecError ?? null));
    const failedFiles = broken.length || results.numFailedTests
      ? broken
      : all.filter((s) => casesOf(s).some((c) => c.status === 'failed'));

    if (!failedFiles.length) {
      this.emit(`::notice title=Tests passed::${results.numPassedTests} passed, ` +
        `${results.numFailedTests} failed, ${results.numTotalTestSuites} suites.`);
      return;
    }

    const rows = [];
    for (const suite of failedFiles) {
      const file = this.rel(fileOf(suite));
      const execError = suite.testExecError;
      const failed = casesOf(suite).filter((c) => c.status === 'failed');

      if (execError || !failed.length) {
        rows.push({
          rank: 0,
          file,
          line: (execError && execError.line) || 1,
          title: `${fileOf(suite)} could not run`,
          message: headline((execError && execError.message) || suite.failureMessage),
        });
        continue;
      }

      for (const c of failed) {
        rows.push({
          rank: 1,
          file,
          // `location` is absent on some failures. `startAt` is not a fallback:
          // it is a millisecond timestamp, and a nine-digit line number points
          // the annotation at nothing.
          line: (c.location && c.location.line) || 1,
          title: c.fullName || c.title || 'unknown test',
          message: headline(c.failureMessages && c.failureMessages[0]),
        });
      }
    }

    rows.sort((a, b) => a.rank - b.rank);

    for (const row of rows.slice(0, MAX_ANNOTATIONS)) {
      this.emit(`::error file=${row.file},line=${row.line}::${esc(row.title)}: ${row.message}`);
    }

    if (rows.length > MAX_ANNOTATIONS) {
      this.emit(`::error title=${rows.length - MAX_ANNOTATIONS} more failures::` +
        `Only the first ${MAX_ANNOTATIONS} are annotated. The rest are in the job log.`);
    }

    this.emit(`::error title=${failedFiles.length} suite(s) failed::` +
      `${esc([...new Set(failedFiles.map((s) => this.rel(fileOf(s))))].join(', '))}`);
  }
}

module.exports = GitHubReporter;
