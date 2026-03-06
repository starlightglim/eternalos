import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SourceMapConsumer } from 'source-map';
import WebSocket from 'ws';

function createJsonRpcClient(ws) {
  let nextId = 1;
  const pending = new Map();

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(message.error.message));
      return;
    }

    resolve(message.result);
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

function buildLineStarts(sourceText) {
  const lineStarts = [0];

  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function offsetToLine(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return high + 1;
}

function ensureFileEntry(files, sourcePath) {
  if (!files.has(sourcePath)) {
    files.set(sourcePath, {
      executableLines: new Set(),
      coveredLines: new Set(),
    });
  }

  return files.get(sourcePath);
}

export class WorkerCoverageCollector {
  constructor({
    inspectorPort,
    workerName,
    projectRoot,
    reportDir,
  }) {
    this.inspectorPort = inspectorPort;
    this.workerName = workerName;
    this.projectRoot = projectRoot;
    this.reportDir = reportDir;
    this.socket = null;
    this.send = null;
  }

  async start() {
    this.socket = new WebSocket(`ws://127.0.0.1:${this.inspectorPort}/core:user:${this.workerName}`);

    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });

    this.send = createJsonRpcClient(this.socket);
    await this.send('Runtime.enable');
    await this.send('Debugger.enable');
  }

  async writeReports() {
    if (!this.send) {
      throw new Error('Coverage collector was not started');
    }

    const coverage = await this.send('Profiler.getBestEffortCoverage');
    const files = await this.#mapCoverageToSources(coverage.result);

    await mkdir(this.reportDir, { recursive: true });

    const summary = this.#createSummary(files);
    const lcov = this.#createLcov(files);
    const rawPath = path.join(this.reportDir, 'worker-coverage.raw.json');
    const summaryPath = path.join(this.reportDir, 'summary.json');
    const textSummaryPath = path.join(this.reportDir, 'summary.txt');
    const lcovPath = path.join(this.reportDir, 'lcov.info');

    await Promise.all([
      writeFile(rawPath, JSON.stringify(coverage, null, 2)),
      writeFile(summaryPath, JSON.stringify(summary, null, 2)),
      writeFile(textSummaryPath, this.#createTextSummary(summary)),
      writeFile(lcovPath, lcov),
    ]);

    return {
      rawPath,
      summaryPath,
      textSummaryPath,
      lcovPath,
      summary,
    };
  }

  async stop() {
    const report = await this.writeReports();
    this.socket?.close();
    this.socket = null;
    this.send = null;
    return report;
  }

  async #mapCoverageToSources(scriptCoverage) {
    const files = new Map();

    for (const script of scriptCoverage) {
      if (!script.url.includes('/.wrangler/tmp/dev-') || !script.url.endsWith('/index.js')) {
        continue;
      }

      const bundlePath = fileURLToPath(script.url);
      const [bundleSource, sourceMapText] = await Promise.all([
        readFile(bundlePath, 'utf8'),
        readFile(`${bundlePath}.map`, 'utf8'),
      ]);

      const sourceMap = JSON.parse(sourceMapText);
      const lineStarts = buildLineStarts(bundleSource);
      const executableGeneratedLines = new Set();
      const coveredGeneratedLines = new Set();

      for (const fn of script.functions) {
        const isBundleWrapper =
          fn.functionName === ''
          && fn.ranges.length > 0
          && fn.ranges[0].startOffset === 0
          && fn.ranges[0].endOffset >= bundleSource.length;

        for (const range of fn.ranges) {
          if (isBundleWrapper) {
            continue;
          }

          const startLine = offsetToLine(lineStarts, range.startOffset);
          const endLine = offsetToLine(lineStarts, Math.max(range.startOffset, range.endOffset - 1));

          for (let line = startLine; line <= endLine; line += 1) {
            executableGeneratedLines.add(line);
            if (range.count > 0) {
              coveredGeneratedLines.add(line);
            }
          }
        }
      }

      const consumer = await new SourceMapConsumer(sourceMap);

      try {
        consumer.eachMapping((mapping) => {
          if (!mapping.source || !mapping.originalLine) {
            return;
          }

          const resolvedSource = path.resolve(path.dirname(bundlePath), mapping.source);
          if (!resolvedSource.startsWith(path.join(this.projectRoot, 'src'))) {
            return;
          }

          if (!executableGeneratedLines.has(mapping.generatedLine)) {
            return;
          }

          const fileEntry = ensureFileEntry(files, resolvedSource);
          fileEntry.executableLines.add(mapping.originalLine);

          if (coveredGeneratedLines.has(mapping.generatedLine)) {
            fileEntry.coveredLines.add(mapping.originalLine);
          }
        });
      } finally {
        if (typeof consumer.destroy === 'function') {
          consumer.destroy();
        }
      }
    }

    return files;
  }

  #createSummary(files) {
    const entries = Array.from(files.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourcePath, fileCoverage]) => {
        const total = fileCoverage.executableLines.size;
        const covered = fileCoverage.coveredLines.size;
        const pct = total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));

        return {
          file: sourcePath,
          lines: {
            covered,
            total,
            pct,
          },
        };
      });

    const totals = entries.reduce(
      (accumulator, entry) => {
        accumulator.covered += entry.lines.covered;
        accumulator.total += entry.lines.total;
        return accumulator;
      },
      { covered: 0, total: 0 }
    );

    return {
      totals: {
        ...totals,
        pct: totals.total === 0 ? 100 : Number(((totals.covered / totals.total) * 100).toFixed(2)),
      },
      files: entries,
    };
  }

  #createTextSummary(summary) {
    const lines = [
      'Worker coverage',
      `Total lines: ${summary.totals.covered}/${summary.totals.total} (${summary.totals.pct}%)`,
      '',
    ];

    for (const entry of summary.files) {
      lines.push(
        `${path.relative(this.projectRoot, entry.file)} ${entry.lines.covered}/${entry.lines.total} (${entry.lines.pct}%)`
      );
    }

    return `${lines.join('\n')}\n`;
  }

  #createLcov(files) {
    const records = [];

    for (const [sourcePath, fileCoverage] of Array.from(files.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      records.push('TN:');
      records.push(`SF:${sourcePath}`);

      for (const lineNumber of Array.from(fileCoverage.executableLines).sort((left, right) => left - right)) {
        const hitCount = fileCoverage.coveredLines.has(lineNumber) ? 1 : 0;
        records.push(`DA:${lineNumber},${hitCount}`);
      }

      records.push(`LF:${fileCoverage.executableLines.size}`);
      records.push(`LH:${fileCoverage.coveredLines.size}`);
      records.push('end_of_record');
    }

    return `${records.join('\n')}\n`;
  }
}
