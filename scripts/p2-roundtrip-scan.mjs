import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanMarkdownVault } from './p2-roundtrip-scan-core.mjs';

const args = process.argv.slice(2);
const vault = valueAfter('--vault');
const outputPath = valueAfter('--out');
const limitValue = valueAfter('--limit');
const check = args.includes('--check');

if (!vault || args.includes('--help')) {
  console.error('用法：node scripts/p2-roundtrip-scan.mjs --vault <Vault路径> [--out <报告路径>] [--limit <数量>] [--check]');
  process.exit(args.includes('--help') ? 0 : 2);
}

const root = path.resolve(vault);
const limit = limitValue === undefined ? undefined : Number(limitValue);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
  console.error('--limit 必须是非负整数');
  process.exit(2);
}

try {
  await access(root);
  const report = await scanMarkdownVault(root, { limit });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    const relative = path.relative(root, absoluteOutput);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('--out 必须位于 Vault 目录之外，避免把报告写入待扫描数据');
    }
    await writeFile(absoluteOutput, serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }

  if (check && (report.summary.changed > 0 || report.summary.errors > 0)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
