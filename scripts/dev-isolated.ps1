# 双端口开发：一个稳定服务 + 一个随便重启的开发服务
#
# 为什么要这个脚本
# ---------------
# MCP 客户端（DSH / Claude Code）在**连接时**抓取工具清单，之后不会自己更新。
# 服务端一重启，旧 sessionId 就失效，而客户端只会拿旧 id 重试，**不会重新握手**——
# 实测确认：服务端重启后客户端永远看不到新工具，必须重开会话。
#
# 所以正确的工作方式是：
#   3000  对局服务 —— 你下棋的地方，改代码期间**不碰它**
#   3100  开发服务 —— 随便重启、随便改，用来验证
#
# 改完代码验证通过后，你自己决定什么时候把 3000 换成新构建。
#
# 用法
# ----
#   pwsh -File scripts/dev-isolated.ps1             # 两个都起
#   pwsh -File scripts/dev-isolated.ps1 -Only dev   # 只起开发服务
#   pwsh -File scripts/dev-isolated.ps1 -Only live  # 只起对局服务
#   pwsh -File scripts/dev-isolated.ps1 -Stop       # 停掉两个
#
param(
  [ValidateSet('both', 'live', 'dev')]
  [string]$Only = 'both',
  [switch]$Stop,
  [int]$LivePort = 3000,
  [int]$DevPort = 3100
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'server'
$liveData = Join-Path $root 'data'
$devData = Join-Path $root 'data-dev'
$pidFile = Join-Path $root '.dev-isolated.json'

function Get-Listener([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Stop-ByPort([int]$Port) {
  $listener = Get-Listener $Port
  if (-not $listener) { return $false }
  try {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 600
    return $true
  } catch {
    Write-Warning "无法停止端口 $Port 上的进程 $($listener.OwningProcess)：$_"
    return $false
  }
}

function Start-Arena([string]$Label, [int]$Port, [string]$DataDir) {
  if (Get-Listener $Port) {
    $owner = (Get-Listener $Port).OwningProcess
    Write-Host "[$Label] 端口 $Port 已被进程 $owner 占用，跳过启动" -ForegroundColor Yellow
    return $null
  }

  if (-not (Test-Path (Join-Path $serverDir 'dist/index.js'))) {
    Write-Host "[$Label] 没有构建产物，先跑 pnpm build" -ForegroundColor Red
    throw "missing $serverDir/dist/index.js"
  }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $log = Join-Path $root "$Label.log"
  $errLog = Join-Path $root "$Label.err.log"

  # Start-Process with redirection keeps the parent attached to the child's
  # pipes, so the calling shell waits for the server to exit. Launch through a
  # detached cmd wrapper instead: it returns immediately and the server keeps
  # running after this script ends.
  $nodeExe = (Get-Command node).Source
  $cmdLine = "set PORT=$Port&& set ARENA_DATA_DIR=$DataDir&& `"$nodeExe`" dist/index.js > `"$log`" 2> `"$errLog`""
  $proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', $cmdLine `
    -WorkingDirectory $serverDir `
    -WindowStyle Hidden `
    -PassThru

  Write-Host "[$Label] 启动中 port=$Port data=$DataDir (wrapper pid=$($proc.Id))" -ForegroundColor Cyan
  return [pscustomobject]@{ label = $Label; port = $Port; data = $DataDir; log = $log }
}

function Wait-Healthy([int]$Port, [int]$Seconds = 15) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $null = Invoke-RestMethod "http://127.0.0.1:$Port/api/rooms" -TimeoutSec 2
      return $true
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return $false
}

# ---------------------------------------------------------------- stop
if ($Stop) {
  $stoppedLive = Stop-ByPort $LivePort
  $stoppedDev = Stop-ByPort $DevPort
  Write-Host "已停止：live=$(if($stoppedLive){'yes'}else{'no'}) dev=$(if($stoppedDev){'yes'}else{'no'})" -ForegroundColor Green
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  return
}

# ---------------------------------------------------------------- start
$started = @()

if ($Only -in @('both', 'live')) {
  $live = Start-Arena -Label 'live' -Port $LivePort -DataDir $liveData
  if ($live) { $started += $live }
}

if ($Only -in @('both', 'dev')) {
  $dev = Start-Arena -Label 'dev' -Port $DevPort -DataDir $devData
  if ($dev) { $started += $dev }
}

# ---------------------------------------------------------------- health
foreach ($entry in $started) {
  if (Wait-Healthy $entry.port) {
    Write-Host "[$($entry.label)] 就绪  http://127.0.0.1:$($entry.port)" -ForegroundColor Green
  } else {
    Write-Host "[$($entry.label)] 未就绪，看日志：$($entry.log)" -ForegroundColor Red
  }
}

if ($started.Count -gt 0) {
  $started | ConvertTo-Json -Depth 3 | Set-Content -Path $pidFile -Encoding utf8
}

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host '----------------------------------------' -ForegroundColor DarkGray
Write-Host ' 对局服务  http://127.0.0.1:'"$LivePort" -ForegroundColor White
Write-Host ' 开发服务  http://127.0.0.1:'"$DevPort" -ForegroundColor White
Write-Host ''
Write-Host ' 改代码流程：' -ForegroundColor DarkGray
Write-Host '   1. 改完 -> pnpm build' -ForegroundColor DarkGray
Write-Host "   2. pwsh -File scripts/dev-isolated.ps1 -Only dev  (重启开发服务)" -ForegroundColor DarkGray
Write-Host "   3. 在 :$DevPort 验证，:$LivePort 的对局完全不受影响" -ForegroundColor DarkGray
Write-Host "   4. 验证通过后，你自己决定何时把 :$LivePort 也切到新构建" -ForegroundColor DarkGray
Write-Host ''
Write-Host ' 注意：重启任一服务都会清空该服务的 MCP 会话，' -ForegroundColor Yellow
Write-Host '       客户端（DSH）需要重开会话才能拿到新工具。' -ForegroundColor Yellow
Write-Host '----------------------------------------' -ForegroundColor DarkGray
