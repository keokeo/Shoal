# 一键启动 / 停止 Shoal（Windows PowerShell 5.1 及以上）。
#   start    构建（web/dist 缺失或比源码旧时）后在后台启动服务，就绪后打开浏览器
#   stop     停止服务；有 agent 会话在运行时先确认（-Force 跳过）
#   restart  stop 后 start
#   status   显示是否在运行
# 端口：-Port，或环境变量 WORKBENCH_PORT，默认 47800。日志：<状态目录>\server.log、server.err.log。
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Command = 'start',
  [int]$Port = 0,
  [switch]$Force,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if ($Port -le 0) { $Port = if ($env:WORKBENCH_PORT) { [int]$env:WORKBENCH_PORT } else { 47800 } }
# Default %LOCALAPPDATA%\Shoal; installs from before the rename keep using %LOCALAPPDATA%\agent-workbench (same rule in server/main.ts).
$StateDir = if ($env:WORKBENCH_STATE_DIR) { $env:WORKBENCH_STATE_DIR } else {
  $new = Join-Path $env:LOCALAPPDATA 'Shoal'; $old = Join-Path $env:LOCALAPPDATA 'agent-workbench'
  if (-not (Test-Path $new) -and (Test-Path $old)) { $old } else { $new }
}
$Url = "http://127.0.0.1:$Port"
$Log = Join-Path $StateDir 'server.log'
$ErrLog = Join-Path $StateDir 'server.err.log'

# 监听该端口的进程；是工作台（命令行含 server/main.ts）就返回它，别的程序占用则报错。
function Find-Server {
  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($procId in $owners) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
    if ($p -and $p.CommandLine -match 'server[\\/]main\.ts') { return $p }
  }
  if ($owners.Count) {
    $names = ($owners | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }) -join ', '
    throw "端口 $Port 被其他程序占用（$names，PID $($owners -join ', ')），换个端口：-Port <n>"
  }
  return $null
}

function Get-State {
  try { return Invoke-RestMethod -Uri "$Url/api/state" -TimeoutSec 3 } catch { return $null }
}

# Call as @(Get-LiveSessions ...): PowerShell unrolls a one-item array on return, and in 5.1 a lone object has no .Count.
function Get-LiveSessions($state) {
  if (-not $state) { return @() }
  return @($state.sessions | Where-Object { $_.status -ne 'exited' })
}

function Test-BuildNeeded {
  $index = Join-Path $Root 'web\dist\index.html'
  if (-not (Test-Path $index)) { return $true }
  $built = (Get-Item $index).LastWriteTime
  $sources = @(Get-ChildItem -Path (Join-Path $Root 'web\src'), (Join-Path $Root 'shared') -Recurse -File) +
    @(Get-Item (Join-Path $Root 'web\index.html'), (Join-Path $Root 'vite.config.ts'), (Join-Path $Root 'package.json'))
  return [bool]($sources | Where-Object { $_.LastWriteTime -gt $built } | Select-Object -First 1)
}

function Invoke-Npm([string[]]$NpmArgs) {
  Push-Location $Root
  try {
    & npm.cmd @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') 失败（退出码 $LASTEXITCODE）" }
  } finally { Pop-Location }
}

function Start-Workbench {
  $running = Find-Server
  if ($running) {
    Write-Host "工作台已在运行：$Url（PID $($running.ProcessId)）"
  } else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '找不到 node，请先安装 Node 24' }
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Write-Host '首次运行，安装依赖…'; Invoke-Npm @('install') }
    if (Test-BuildNeeded) { Write-Host '前端有更新，正在构建…'; Invoke-Npm @('run', 'build') }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    # 独立的隐藏控制台：关掉这个窗口不会带走服务和 agent。
    $proc = Start-Process -FilePath 'node' -ArgumentList @('server/main.ts', '--port', "$Port") -WorkingDirectory $Root `
      -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError $ErrLog -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Get-State)) {
      if ($proc.HasExited) {
        Write-Host (Get-Content $ErrLog -Tail 20 -ErrorAction SilentlyContinue | Out-String)
        throw "服务启动失败（退出码 $($proc.ExitCode)），日志：$ErrLog"
      }
      if ((Get-Date) -gt $deadline) { throw "30 秒内服务没有就绪，日志：$Log" }
      Start-Sleep -Milliseconds 300
    }
    Write-Host "工作台已启动：$Url（PID $($proc.Id)），日志：$Log"
  }
  if (-not $NoBrowser) { Start-Process $Url }
}

function Stop-Workbench {
  $running = Find-Server
  if (-not $running) { Write-Host "工作台没有在 $Port 端口运行"; return }
  $live = @(Get-LiveSessions (Get-State))
  if ($live.Count -and -not $Force) {
    Write-Host "有 $($live.Count) 个 agent 会话还在运行，停止服务会结束它们（之后可在面板里续接）。"
    $answer = Read-Host '继续？[y/N]'
    if ($answer -notmatch '^(y|yes|是)$') { Write-Host '已取消'; return }
  }
  # /T：连同服务启动的 agent 进程一起结束。
  & taskkill.exe /PID $running.ProcessId /T /F | Out-Null
  $deadline = (Get-Date).AddSeconds(10)
  while (Find-Server) {
    if ((Get-Date) -gt $deadline) { throw "PID $($running.ProcessId) 没有退出" }
    Start-Sleep -Milliseconds 200
  }
  Write-Host "工作台已停止（PID $($running.ProcessId)）"
}

try {
  switch ($Command) {
    'start' { Start-Workbench }
    'stop' { Stop-Workbench }
    'restart' { Stop-Workbench; if (-not (Find-Server)) { Start-Workbench } }
    'status' {
      $running = Find-Server
      if ($running) {
        $live = @(Get-LiveSessions (Get-State))
        Write-Host "运行中：$Url（PID $($running.ProcessId)，启动于 $($running.CreationDate)），在运行的 agent 会话 $($live.Count) 个"
      } else {
        Write-Host "未运行（端口 $Port）"
        exit 3
      }
    }
  }
} catch {
  Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
