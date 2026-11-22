import { accessSync, cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployDst = path.resolve(root, 'deploy-dst');
const webDist = path.resolve(root, 'web/dist');

console.log('[deploy] 1/3 构建所有子项目 (shared, server, web)...');
// tsc does not prune stale outputs. A dist/mcp/stdio.js left behind from
// before the stdio adapter was retired would otherwise be shipped verbatim,
// so every bundle starts from an empty dist.
rmSync(path.join(root, 'server/dist'), { recursive: true, force: true });
rmSync(webDist, { recursive: true, force: true });
execSync('pnpm build', { cwd: root, stdio: 'inherit' });
accessSync(path.join(webDist, 'index.html'));

const staging = mkdtempSync(path.join(root, '.arena-bundle-'));
const stagedBundle = path.join(staging, 'package');
const previousBundle = path.join(staging, 'previous');
let installed = false;

try {
  console.log('[deploy] 2/3 打包可压缩传输的生产依赖...');
  // An archive can flatten Windows junctions and break pnpm's default dependency layout.
  const deployCommand = [
    'pnpm --config.node-linker=hoisted --config.inject-workspace-packages=true',
    `--filter @arena/server deploy --prod ${path.basename(staging)}/package`,
  ].join(' ');
  execSync(deployCommand, { cwd: root, stdio: 'inherit' });

  console.log('[deploy] 3/3 复制前端产物并更新 deploy-dst...');
  cpSync(webDist, path.join(stagedBundle, 'web'), { recursive: true });

  if (existsSync(deployDst)) renameSync(deployDst, previousBundle);
  try {
    renameSync(stagedBundle, deployDst);
    installed = true;
  } catch (error) {
    if (existsSync(previousBundle)) renameSync(previousBundle, deployDst);
    throw error;
  }
} finally {
  if (installed || !existsSync(previousBundle)) rmSync(staging, { recursive: true, force: true });
}

console.log('\n======================================================');
console.log(' [deploy] 成功生成独立部署包: deploy-dst/');
console.log('======================================================');
console.log(' 本地运行:');
console.log('   cd deploy-dst && node dist/index.js');
console.log('');
console.log(' 部署到其他机器:');
console.log('   1. 将整个 deploy-dst 目录压缩为 zip 或 tar.gz');
console.log('   2. 发送到目标服务器并解压 (目标机仅需 Node.js >= 20)');
console.log('   3. 进入目录执行: node dist/index.js (或 npm start)');
console.log('======================================================\n');
