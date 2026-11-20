import { rmSync, cpSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployDst = path.resolve(root, 'deploy-dst');
const webDist = path.resolve(root, 'web/dist');

console.log('[deploy] 1/3 构建所有子项目 (shared, server, web)...');
execSync('pnpm build', { cwd: root, stdio: 'inherit' });

if (existsSync(deployDst)) {
  console.log('[deploy] 清理已存在的 deploy-dst...');
  rmSync(deployDst, { recursive: true, force: true });
}

console.log('[deploy] 2/3 执行 pnpm deploy 抽离生产运行包...');
execSync('pnpm --filter @arena/server deploy --prod --legacy deploy-dst', { cwd: root, stdio: 'inherit' });

if (existsSync(webDist)) {
  console.log('[deploy] 3/3 拷贝前端静态网页产物到 deploy-dst/web...');
  cpSync(webDist, path.resolve(deployDst, 'web'), { recursive: true });
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
