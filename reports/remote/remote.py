#!/usr/bin/env python3
"""
market-watch 远程操作工具集 —— 所有 quant-server 操作的唯一入口。

用法：
  python3 reports/remote/remote.py status [--date YYYY-MM-DD]
  python3 reports/remote/remote.py probe [TOKEN]
  python3 reports/remote/remote.py set-token TOKEN
  python3 reports/remote/remote.py rerun-scan YYYY-MM-DD [--sleep 0.8] [--concurrency 2]
  python3 reports/remote/remote.py run [YYYY-MM-DD] [--sleep 0.8]

设计原则（踩坑沉淀，见 MEMORY.md Windows 坑位表）：
  - 所有 PS 脚本走 scp + powershell -File，不用 EncodedCommand（避免 base64 长度/编码问题）
  - 所有上传文件转 CRLF
  - PS 脚本里用 $ 变量，靠 scp 文件模式避免 zsh 吃 $
  - 输出统一 chcp 65001 + UTF-8 解码
  - 后台任务用 Win32_Process.Create（ssh 断开不断连）
  - scan 补跑用 python -u 让进度实时 flush（snapshot 进度在 stderr，默认被缓冲）
"""

import subprocess, argparse, os, datetime, tempfile, textwrap, sys

SSH_HOST = "quant-server"
REMOTE_WORK = r"C:\workspace"
REMOTE_MAIN = r"C:\workspace\trend-trading-agents"
REMOTE_SITE = r"C:\workspace\market-watch"
REMOTE_CMD = r"C:\workspace\market-watch\reports\remote\run_market_watch.cmd"
REMOTE_SNAPSHOT = r"C:\workspace\trend-trading-agents\skills\watchlist\scripts\snapshot.py"
REMOTE_VENV_PY = r"C:\workspace\trend-trading-agents\.venv\Scripts\python.exe"
REMOTE_NODE = r"C:\Program Files\nodejs\node.exe"
XUEQIU_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"


def _ssh_run(cmd, timeout=30, capture=True):
    """执行 ssh 命令，返回 (rc, stdout, stderr)。"""
    r = subprocess.run(['ssh', SSH_HOST, cmd],
                       capture_output=capture, timeout=timeout)
    return r.returncode, r.stdout.decode('utf-8', errors='replace'), r.stderr.decode('utf-8', errors='replace')


def _scp_run_ps(ps_script, timeout=30):
    """把 PS 脚本写到临时文件，scp 上传（CRLF），远程 -File 执行，返回输出。

    这是唯一可靠的本地→远程 PS 执行方式（避开 zsh 吃 $、base64 长度、编码问题）。
    """
    # 本地写 CRLF 文件
    with tempfile.NamedTemporaryFile(mode='w', suffix='.ps1', delete=False, newline='') as f:
        f.write(ps_script.replace('\n', '\r\n'))
        local = f.name
    try:
        remote_ps1 = REMOTE_WORK + r'\_remote_tmp.ps1'
        r = subprocess.run(['scp', local, f'{SSH_HOST}:{remote_ps1}'],
                           capture_output=True, timeout=15)
        if r.returncode != 0:
            return f"[scp failed] {r.stderr.decode('utf-8', errors='replace').strip()}"
        # 远程执行
        r = subprocess.run(['ssh', SSH_HOST, 'powershell', '-NoProfile', '-File', remote_ps1],
                           capture_output=True, timeout=timeout)
        out = r.stdout.decode('utf-8', errors='replace')
        # 过滤 PS 版权头
        lines = [l for l in out.split('\n')
                 if 'Windows PowerShell' not in l and 'go.microsoft.com' not in l]
        return '\n'.join(lines).rstrip()
    except subprocess.TimeoutExpired:
        return "[ERROR] SSH 超时"
    finally:
        os.unlink(local)


# ============================================================
# 子命令：status —— 查 pipeline 全貌
# ============================================================
PS_STATUS = r"""
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$date = '__DATE__'
$mmdd = $date.Substring(5).Replace('-', '')

[Console]::WriteLine("=== PIPELINE PROCESSES ===")
Get-CimInstance Win32_Process | Where-Object {
    $c = ($_.CommandLine -join ' ')
    $c -match 'snapshot\.py|scan-all|diff-cli|candidates-cli|build:report|run_market_watch'
} | ForEach-Object {
    $up = [math]::Round(((Get-Date) - $_.CreationDate).TotalMinutes, 1)
    [Console]::WriteLine("  " + $_.Name + " pid=" + $_.ProcessId + " uptime=" + $up + "min")
}

[Console]::WriteLine("")
[Console]::WriteLine("=== SCAN PROGRESS ===")
$scan_full = '__WORK__\scan_' + $date + '.log'
$scan_short = '__WORK__\scan_' + $mmdd + '.log'
$scan_tmp = '__MAIN__\scan_out.tmp'
if (Test-Path $scan_full) {
    [Console]::WriteLine("  [from scan_$date.log]")
    Get-Content $scan_full -Encoding Default -Tail 5 | ForEach-Object { [Console]::WriteLine("  " + $_) }
} elseif (Test-Path $scan_short) {
    [Console]::WriteLine("  [from scan_$mmdd.log]")
    Get-Content $scan_short -Encoding Default -Tail 5 | ForEach-Object { [Console]::WriteLine("  " + $_) }
} elseif (Test-Path $scan_tmp) {
    Get-Content $scan_tmp -Encoding UTF8 -Tail 3 | ForEach-Object { [Console]::WriteLine("  " + $_) }
} else {
    [Console]::WriteLine("  (no scan log found)")
}

[Console]::WriteLine("")
[Console]::WriteLine("=== FILE STATUS ===")
$raw   = '__MAIN__\data\watchlist\raw\'   + $date + '.json'
$diff  = '__MAIN__\data\watchlist\diff\'  + $date + '.json'
$cand  = '__MAIN__\data\watchlist\derived\' + $date + '-candidates.json'
$daily = '__SITE__\daily\' + $date + '.json'
foreach ($f in @(
    @{Label="raw       "; Path=$raw},
    @{Label="diff      "; Path=$diff},
    @{Label="candidates"; Path=$cand},
    @{Label="daily     "; Path=$daily}
)) {
    if (Test-Path $f.Path) {
        $sz = [math]::Round((Get-Item $f.Path).Length / 1MB, 2)
        $ts = (Get-Item $f.Path).LastWriteTime.ToString("HH:mm:ss")
        [Console]::WriteLine("  [" + $f.Label + "] " + $sz + " MB  " + $ts)
    } else {
        [Console]::WriteLine("  [" + $f.Label + "] MISSING")
    }
}

[Console]::WriteLine("")
[Console]::WriteLine("=== LATEST LOG (market-watch.log) ===")
$mw_log = '__MAIN__\market-watch.log'
if (Test-Path $mw_log) {
    Get-Content $mw_log -Tail 10 | ForEach-Object { [Console]::WriteLine("  " + $_) }
} else {
    [Console]::WriteLine("  (no market-watch.log)")
}

[Console]::WriteLine("")
[Console]::WriteLine("=== MAIN REPO ===")
Push-Location '__MAIN__'
[Console]::WriteLine("  Branch: " + (git branch --show-current))
$behind = (git rev-list --count HEAD..origin/main 2>$null)
if ($behind) { [Console]::WriteLine("  Behind origin: " + $behind + " commits") }
else { [Console]::WriteLine("  Up to date") }
$st = git status --short
if ($st) { [Console]::WriteLine("  Uncommitted: " + @($st).Count + " files") }
else { [Console]::WriteLine("  Clean") }
Pop-Location

[Console]::WriteLine("")
[Console]::WriteLine("=== SITE REPO ===")
Push-Location '__SITE__'
[Console]::WriteLine("  Branch: " + (git branch --show-current))
$behind2 = (git rev-list --count HEAD..origin/main 2>$null)
if ($behind2) { [Console]::WriteLine("  Behind origin: " + $behind2 + " commits") }
else { [Console]::WriteLine("  Up to date") }
$st2 = git status --short
if ($st2) { [Console]::WriteLine("  Uncommitted: " + @($st2).Count + " files") }
else { [Console]::WriteLine("  Clean") }
Pop-Location
"""


def cmd_status(args):
    date = args.date or datetime.date.today().isoformat()
    print(f"=== quant-server status @ {datetime.datetime.now().strftime('%H:%M:%S')} (date={date}) ===")
    print()
    script = (PS_STATUS
              .replace("__DATE__", date)
              .replace("__MAIN__", REMOTE_MAIN)
              .replace("__SITE__", REMOTE_SITE)
              .replace("__WORK__", REMOTE_WORK))
    print(_scp_run_ps(script, timeout=30))


# ============================================================
# 子命令：probe —— 测雪球 token 是否有效
# ============================================================
PS_PROBE = r"""
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$token = '__TOKEN__'
$ua = '__UA__'
$code = "const https=require('https');const t='" + $token + "';https.get('https://xueqiu.com/rainbow/ai/abnormal/reasons.json',{headers:{'Cookie':'xq_a_token='+t,'User-Agent':'" + $ua + "','Host':'xueqiu.com'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log('STATUS='+r.statusCode);console.log('BODY='+d.substring(0,300));process.exit(0)})}).on('error',e=>{console.log('ERR='+e.message);process.exit(1)})"
Set-Content -Path C:\workspace\_probe.js -Value $code -Encoding UTF8
& '__NODE__' C:\workspace\_probe.js
"""


def cmd_probe(args):
    """测 token 是否有效。不传 token 则读 snapshot.py 默认值。"""
    token = args.token
    if not token:
        # 从远程 snapshot.py 读当前默认 token
        rc, out, err = _ssh_run(f'powershell -NoProfile -Command "Select-String -Path \'{REMOTE_SNAPSHOT}\' -Pattern \'XUEQIU_TOKEN\' | ForEach-Object {{ $_.Line.Trim() }}"', timeout=15)
        print("当前 snapshot.py 里的 token 行：")
        print(out.strip())
        # 提取 token 值（格式: os.environ.get("XUEQIU_TOKEN", "XqTest...")）
        import re as _re
        for line in out.split('\n'):
            s = line.strip()
            if 'XUEQIU_TOKEN' in s:
                m = _re.search(r'"((?:XqTest|xq_a_token=)[^"]*)"', s)
                if m:
                    token = m.group(1)
                break
        if not token:
            print("[ERROR] 无法提取 token，请手动传：probe <TOKEN>")
            return
        print(f"\n用提取到的 token 测试：{token[:20]}...\n")

    script = (PS_PROBE
              .replace("__TOKEN__", token)
              .replace("__UA__", XUEQIU_UA)
              .replace("__NODE__", REMOTE_NODE))
    print(_scp_run_ps(script, timeout=20))


# ============================================================
# 子命令：set-token —— 更新 snapshot.py 里的 token 默认值
# （方案A 后 token 不再写在 run_market_watch.cmd，统一由 snapshot.py
#  的 os.environ.get("XUEQIU_TOKEN", "<默认值>") 提供；set-token 即改该默认值）
# ============================================================
PS_SET_TOKEN = r"""
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$path = '__CMD__'
$new = '__TOKEN__'
$txt = [IO.File]::ReadAllText($path, [Text.Encoding]::Default)
$replaced = $false
# 1) snapshot.py 默认 token：os.environ.get("XUEQIU_TOKEN", "XqTest....")
if ($txt -match '"XqTest\S+"') {
    $old_match = $Matches[0]
    $txt = $txt -replace [regex]::Escape($old_match), ('"' + $new + '"')
    [Console]::WriteLine("REPLACED default: " + $old_match + " -> " + ('"' + $new + '"'))
    $replaced = $true
}
# 2) 兼容：若仍有旧 run_market_watch.cmd 的 XUEQIU_TOKEN=<非空白> 行也一并改
if ($txt -match 'XUEQIU_TOKEN=\S+') {
    $old_match = $Matches[0]
    $txt = $txt -replace [regex]::Escape($old_match), ('XUEQIU_TOKEN=' + $new)
    [Console]::WriteLine("REPLACED legacy: " + $old_match + " -> XUEQIU_TOKEN=" + $new.Substring(0,15) + "...")
    $replaced = $true
}
if ($replaced) {
    [IO.File]::WriteAllText($path, $txt, [Text.Encoding]::Default)
} else {
    [Console]::WriteLine("[ERROR] 未在 " + $path + " 找到可替换的 token（既不是 XqTest 默认值也不是 XUEQIU_TOKEN= 行）")
}
# verify
$t2 = [IO.File]::ReadAllText($path, [Text.Encoding]::Default)
$t2 -split "`r?`n" | Where-Object { $_ -match 'XUEQIU_TOKEN' } | ForEach-Object { [Console]::WriteLine("NOW: $_") }
"""


def cmd_set_token(args):
    token = args.token
    # 兼容两种输入：纯 token（XqTest...）或带前缀 xq_a_token=xxx
    if token.startswith('xq_a_token='):
        token = token[len('xq_a_token='):]
    if not token.startswith('XqTest'):
        print("[WARN] token 不以 XqTest 开头，确认是雪球 token？继续执行...")

    script = (PS_SET_TOKEN
              .replace("__CMD__", REMOTE_SNAPSHOT)
              .replace("__TOKEN__", token))
    print(_scp_run_ps(script, timeout=15))
    print("\n→ 现在跑 probe 验证新 token：")
    args.token = token
    cmd_probe(args)


# ============================================================
# 子命令：rerun-scan —— 补跑单日 scan（python -u 实时日志）
# ============================================================
# scan cmd 模板（注意：--concurrency 2 和 >> 之间必须有空格，见坑#13）
SCAN_CMD_TEMPLATE = r"""@echo off
setlocal
cd /d C:\workspace\trend-trading-agents
set PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%
set PY=C:\workspace\trend-trading-agents\.venv\Scripts\python.exe
echo %date% %time% ===== scan __DATE__ start (python -u) =====> C:\workspace\scan__MMDD__.log
%PY% -u skills\watchlist\scripts\snapshot.py --date __DATE__ --sleep __SLEEP__ --concurrency __CONC__ >> C:\workspace\scan__MMDD__.log 2>&1
echo %date% %time% ===== scan done rc=%errorlevel% ===== >> C:\workspace\scan__MMDD__.log
"""

PS_LAUNCH = r"""
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
# 删旧日志（避免误读上次进度）
$oldlog = '__WORK__\scan__MMDD__.log'
if (Test-Path $oldlog) { Remove-Item $oldlog -Force }
# 后台启动 cmd（Win32_Process.Create，ssh 断开不断连）
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c __WORK__\_rerun_scan.cmd'}
if ($r.ReturnValue -eq 0) {
    [Console]::WriteLine("STARTED pid=" + $r.ProcessId)
    [Console]::WriteLine("log: " + $oldlog)
    [Console]::WriteLine("查进度: python3 reports/remote/remote.py status --date __DATE__")
} else {
    [Console]::WriteLine("[ERROR] Win32_Process.Create failed ReturnValue=" + $r.ReturnValue)
}
"""


def cmd_rerun_scan(args):
    date = args.date
    mmdd = date[5:7] + date[8:10]  # 0810
    sleep = args.sleep
    conc = args.concurrency

    # token 来源：snapshot.py 里的默认值（os.environ.get("XUEQIU_TOKEN", "<默认值>")）。
    # set-token 已更新该默认值，故 rerun 直接让 snapshot 用文件默认值，无需显式传 env。
    ps_cmd = 'powershell -NoProfile -Command "(Get-Content \'%s\' | Select-String \'XUEQIU_TOKEN\').Line"' % REMOTE_SNAPSHOT
    rc, out, err = _ssh_run(ps_cmd, timeout=15)
    if rc == 0 and out.strip():
        for line in out.split('\n'):
            if 'XUEQIU_TOKEN' in line:
                print(f"snapshot.py token 行: {line.strip()[:40]}...")
                break
    else:
        print("[WARN] 未能读取 snapshot.py token 行（不影响运行，snapshot 用默认值）")

    # 生成 cmd 内容（不再注入 XUEQIU_TOKEN env，snapshot 用文件默认值）
    cmd_content = (SCAN_CMD_TEMPLATE
                   .replace("__DATE__", date)
                   .replace("__MMDD__", mmdd)
                   .replace("__SLEEP__", str(sleep))
                   .replace("__CONC__", str(conc)))

    # scp 上传 cmd（CRLF）
    with tempfile.NamedTemporaryFile(mode='w', suffix='.cmd', delete=False, newline='') as f:
        f.write(cmd_content.replace('\n', '\r\n'))
        local = f.name
    try:
        remote_cmd = REMOTE_WORK + r'\_rerun_scan.cmd'
        subprocess.run(['scp', local, f'{SSH_HOST}:{remote_cmd}'],
                       capture_output=True, timeout=15)
    finally:
        os.unlink(local)

    # 后台启动
    script = (PS_LAUNCH
              .replace("__WORK__", REMOTE_WORK)
              .replace("__MMDD__", mmdd)
              .replace("__DATE__", date))
    print(_scp_run_ps(script, timeout=15))


# ============================================================
# 子命令：run —— 后台跑 run_market_watch.cmd 全链路
# ============================================================
PS_RUN = r"""
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$cmd = 'cmd /c __CMD__ __DATE__ __SLEEP__'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd}
if ($r.ReturnValue -eq 0) {
    [Console]::WriteLine("STARTED pid=" + $r.ProcessId)
    [Console]::WriteLine("全链路日志: __MAIN__\market-watch.log")
    [Console]::WriteLine("查进度: python3 reports/remote/remote.py status --date __DATE__")
} else {
    [Console]::WriteLine("[ERROR] Win32_Process.Create failed ReturnValue=" + $r.ReturnValue)
}
"""


def cmd_run(args):
    date = args.date or datetime.date.today().isoformat()
    sleep = args.sleep
    script = (PS_RUN
              .replace("__CMD__", REMOTE_CMD)
              .replace("__DATE__", date)
              .replace("__SLEEP__", str(sleep))
              .replace("__MAIN__", REMOTE_MAIN))
    print(_scp_run_ps(script, timeout=15))


# ============================================================
# 子命令：build —— raw 已存在，跑后续步骤（git push + build:report + site push）
# ============================================================
# cmd 模板：跳过 scan，直接走 build + push
BUILD_CMD_TEMPLATE = r"""@echo off
setlocal enabledelayedexpansion
set MAIN_REPO=C:\workspace\trend-trading-agents
set SITE_REPO=C:\workspace\market-watch
set LOG=C:\workspace\build___MMDD__.log
set PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%
set TODAY=__DATE__

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] ===== build-only start (target=!TODAY!) =====>> "%LOG%"
cd /d "%MAIN_REPO%"

::: diff + candidates（build:report 依赖这两个中间文件）
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] diff + candidates...>> "%LOG%"
call npm run diff -- --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] diff FAILED (rc=!errorlevel!)>> "%LOG%"
  exit /b 1
)
call npm run candidates -- --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] candidates FAILED (rc=!errorlevel!)>> "%LOG%"
  exit /b 1
)

::: build:report --date
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] build:report --date !TODAY!...>> "%LOG%"
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] build:report (--date) FAILED (rc=!errorlevel!)>> "%LOG%"
  exit /b 1
)

::: build:report full
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] build:report (full)...>> "%LOG%"
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] build:report (full) FAILED (rc=!errorlevel!)>> "%LOG%"
  exit /b 1
)

:::: git push main repo (build finished; commit outside () block)
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] Push main repo data...>> "%LOG%"
cd /d "%MAIN_REPO%"
git add data\ >> "%LOG%" 2>&1
git diff --cached --quiet
if !errorlevel! equ 0 goto main_no_change
git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] Main repo git push FAILED (rc=!errorlevel!)>> "%LOG%"
  exit /b 1
)
:main_no_change

::: git push site repo
cd /d "%SITE_REPO%"
git add daily\ series\ meta.json *.json >> "%LOG%" 2>&1
git diff --cached --quiet
if !errorlevel! equ 0 (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
  echo [!TS!] No data change, skip site push>> "%LOG%"
  echo [!TS!] ===== build-only done, no change (target=!TODAY!) =====>> "%LOG%"
  exit /b 0
)
git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] Site repo git push FAILED (rc=!errorlevel!)>> "%LOG%"
  exit /b 1
)

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] ===== build-only done (target=!TODAY!) =====>> "%LOG%"
exit /b 0
"""

PS_BUILD = r"""
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c __WORK__\_build.cmd'}
if ($r.ReturnValue -eq 0) {
    [Console]::WriteLine("STARTED pid=" + $r.ProcessId)
    [Console]::WriteLine("build 日志: __WORK__\build___MMDD__.log")
    [Console]::WriteLine("查进度: python3 reports/remote/remote.py status --date __DATE__")
} else {
    [Console]::WriteLine("[ERROR] Win32_Process.Create failed ReturnValue=" + $r.ReturnValue)
}
"""


def cmd_build(args):
    date = args.date
    mmdd = date[5:7] + date[8:10]
    cmd_content = (BUILD_CMD_TEMPLATE
                   .replace("__DATE__", date)
                   .replace("__MMDD__", mmdd))
    # scp 上传 cmd（CRLF）
    with tempfile.NamedTemporaryFile(mode='w', suffix='.cmd', delete=False, newline='') as f:
        f.write(cmd_content.replace('\n', '\r\n'))
        local = f.name
    try:
        remote_cmd = REMOTE_WORK + r'\_build.cmd'
        subprocess.run(['scp', local, f'{SSH_HOST}:{remote_cmd}'],
                       capture_output=True, timeout=15)
    finally:
        os.unlink(local)
    # 后台启动
    script = (PS_BUILD
              .replace("__WORK__", REMOTE_WORK)
              .replace("__MMDD__", mmdd)
              .replace("__DATE__", date))
    print(_scp_run_ps(script, timeout=15))


# ============================================================
# 入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description="market-watch 远程操作工具集",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""
        示例：
          remote.py status                        # 查今天状态
          remote.py status --date 2026-08-10      # 查指定日期
          remote.py probe                         # 测当前 token
          remote.py probe XqTestabc123...         # 测指定 token
          remote.py set-token XqTestabc123...     # 更新 token
          remote.py rerun-scan 2026-08-10         # 补跑单日 scan
          remote.py rerun-scan 2026-08-10 --sleep 0.5
          remote.py run 2026-08-10                # 后台跑全链路
          remote.py build 2026-08-10              # raw 已存在，只跑 build+push
        """))
    sub = parser.add_subparsers(dest='command', required=True)

    p_status = sub.add_parser('status', help='查 pipeline 状态')
    p_status.add_argument('--date', default=None, help='日期 YYYY-MM-DD')
    p_status.set_defaults(func=cmd_status)

    p_probe = sub.add_parser('probe', help='测雪球 token 是否有效')
    p_probe.add_argument('token', nargs='?', default=None, help='token（不传则读 run_market_watch.cmd 现有的）')
    p_probe.set_defaults(func=cmd_probe)

    p_set = sub.add_parser('set-token', help='更新 run_market_watch.cmd 的 token')
    p_set.add_argument('token', help='新 token')
    p_set.set_defaults(func=cmd_set_token)

    p_rerun = sub.add_parser('rerun-scan', help='补跑单日 scan（python -u 实时日志）')
    p_rerun.add_argument('date', help='日期 YYYY-MM-DD')
    p_rerun.add_argument('--sleep', type=float, default=0.8, help='请求间隔秒数（默认 0.8）')
    p_rerun.add_argument('--concurrency', type=int, default=2, help='并发数（默认 2）')
    p_rerun.set_defaults(func=cmd_rerun_scan)

    p_run = sub.add_parser('run', help='后台跑 run_market_watch.cmd 全链路')
    p_run.add_argument('date', nargs='?', default=None, help='日期 YYYY-MM-DD（默认今天）')
    p_run.add_argument('--sleep', type=float, default=0.8, help='请求间隔秒数（默认 0.8）')
    p_run.set_defaults(func=cmd_run)

    p_build = sub.add_parser('build', help='raw 已存在，只跑 build:report + git push')
    p_build.add_argument('date', help='日期 YYYY-MM-DD')
    p_build.set_defaults(func=cmd_build)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
