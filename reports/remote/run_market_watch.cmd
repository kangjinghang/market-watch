@echo off
setlocal enabledelayedexpansion
set MAIN_PUSH_TRIES=0
set SITE_PUSH_TRIES=0
set MAIN_REPO=C:\workspace\trend-trading-agents
set SITE_REPO=C:\workspace\market-watch
set WATCHLIST_DIR=%MAIN_REPO%\data\watchlist
set LOG=C:\workspace\market-watch.log
set PATH=C:\Program Files\nodejs;%APPDATA%\npm;%USERPROFILE%\.pyenv\pyenv-win\versions\3.11.9;%PATH%
set TRADING_PYTHON=%MAIN_REPO%\.venv\Scripts\python.exe

:: ============================================================
:: ???????????????????????
::   ????: run_market_watch.cmd [YYYY-MM-DD] [sleep]
::     ?????       -> ??????????????? MarketWatch19/23??
::     ??????       -> ????y?????????????????????????????
::   ??:   run_market_watch.cmd 2026-07-30 0.8
:: ============================================================
set TARGET_DATE=
set SLEEP=0.3
set VERIFY=0
if "%~1"=="--verify" (
  set VERIFY=1
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"`) do set TARGET_DATE=%%a
  goto :verify_setup
)
if not "%~1"=="" set TARGET_DATE=%~1
if not "%~2"=="" set SLEEP=%~2
if "%TARGET_DATE%"=="" (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"`) do set TARGET_DATE=%%a
)
set TODAY=%TARGET_DATE%

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] ===== market-watch start (target=!TODAY!, sleep=!SLEEP!) =====>> "%LOG%"
cd /d "%MAIN_REPO%"

:: --- ????????????????????????????? ---
set DATA_DATE=
for /f "delims=" %%a in ('dir /b /o-n "%MAIN_REPO%\data\watchlist\raw\*.json" 2^>nul') do if not defined DATA_DATE set DATA_DATE=%%~na
if "!DATA_DATE!"=="!TODAY!" goto :already_done

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] git sync (checkout + clean + pull)>> "%LOG%"
git checkout -- . 2>nul
git clean -fdq 2>nul
git pull --rebase --quiet >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :git_pull_fail
:: 再校验 snapshot.py 可编译（防编码/语法损坏白跑 30 分钟）
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] syntax check snapshot.py>> "%LOG%"
"%MAIN_REPO%\.venv\Scripts\python.exe" -m py_compile "%MAIN_REPO%\skills\watchlist\scripts\snapshot.py" >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :syntax_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] git sync + syntax OK>> "%LOG%"

::: --- 生产前门禁：管线逻辑自检（防坏代码上线污染数据）---
::: 等价于提交前的 npm run verify：用假 raw 跑真实 diff/candidates/build(dry-run)，
::: 断言产物齐全。任一环节逻辑坏掉 → 直接中止，不跑 snapshot（避免白扫 30 分钟 + 污染）。
::: 即便有人绕过 pre-commit 把坏代码 push 进来，线上任务也会在此 self-check 失败、拒绝运行。
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] pipeline self-check (verify)>> "%LOG%"
call npm run verify >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] pipeline self-check FAILED, abort before snapshot (bad code pushed?)>> "%LOG%"
  goto :scan_fail
)
echo [!TS!] pipeline self-check OK>> "%LOG%"

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] snapshot (python -u foreground, hard timeout 3h via outer guard)>> "%LOG%"
:: 前台直跑 python（避免 Start-Process -Redirect -NoNewWindow 在 SSH 非交互下卡/挂，
:: 以及 SCAN_RC_FILE 临时文件传递退出码不可靠导致误判 snapshot 失败）。
:: 超时保护交给外层：若 3h 仍未结束，由 scheduled task 的"停止任务"兜底。
"%MAIN_REPO%\.venv\Scripts\python.exe" -u "%MAIN_REPO%\skills\watchlist\scripts\snapshot.py" --date "!TODAY!" --concurrency 2 --sleep "!SLEEP!" >> "%LOG%" 2>&1
set SCAN_EXIT=!errorlevel!
if !SCAN_EXIT! neq 0 goto :scan_fail

:diff_stage
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] diff (--date !TODAY!)>> "%LOG%"
call npm run diff -- --date "!TODAY!" >> "%LOG%" 2>&1
:: npm 在 cmd 下的 errorlevel 不可靠（常因无关 stderr 返回非 0），改以输出文件是否生成判断成败
if not exist "%WATCHLIST_DIR%\diff\!TODAY!.json" (
  echo [!TS!] diff output missing, treat as FAIL>> "%LOG%"
  goto :scan_fail
)
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] candidates (--date !TODAY!)>> "%LOG%"
call npm run candidates -- --date "!TODAY!" >> "%LOG%" 2>&1
:: 同上：以输出文件存在性为准
if not exist "%WATCHLIST_DIR%\derived\!TODAY!-candidates.json" (
  echo [!TS!] candidates output missing, treat as FAIL>> "%LOG%"
  goto :scan_fail
)
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] snapshot+diff+candidates OK>> "%LOG%"

:: VERIFY 模式：只验证调度产物契约，不 git push / 不真 build，直接退出
if !VERIFY! equ 1 (
  call npm run build:report -- --in "%WATCHLIST_DIR%" --out "%WATCHLIST_DIR%" --date "!TODAY!" --dry-run >> "%LOG%" 2>&1
  if not exist "%WATCHLIST_DIR%\daily\!TODAY!.json" (
    echo [!TS!] VERIFY FAIL: daily missing after build --dry-run>> "%LOG%"
    exit /b 1
  )
  echo [!TS!] VERIFY PIPELINE_OK — diff/candidates/daily 产物齐全，全链路调度成功路径可达>> "%LOG%"
  exit /b 0
)

:: --- ??????scan-all errorlevel ?????? Node.js ???????????????? 0 ---
:: ???????? raw ????????????????
set /a RAW_RETRY=0
:raw_check
if exist "%MAIN_REPO%\data\watchlist\raw\!TODAY!.json" goto :real_scan_ok
set /a RAW_RETRY+=1
if !RAW_RETRY! leq 6 (timeout /t 5 /nobreak >nul & goto :raw_check)
if !SCAN_EXIT! neq 0 (
  echo [!TS!] scan-all exited !SCAN_EXIT! and raw missing=!TODAY!>> "%LOG%"
)
goto :scan_fail

:real_scan_ok

echo [!TS!] scan-all OK>> "%LOG%"

if not exist "%MAIN_REPO%\data\watchlist\raw\!TODAY!.json" goto :fresh_fail

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] Freshness OK: !TODAY!>> "%LOG%"

echo [!TS!] Push main repo data...>> "%LOG%"
cd /d "%MAIN_REPO%"
git add data\
git diff --cached --quiet
if !errorlevel! equ 0 goto :main_no_change
git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
:main_push_retry
git pull --rebase --quiet >> "%LOG%" 2>&1
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! equ 0 goto :main_no_change
set /a MAIN_PUSH_TRIES+=1
if !MAIN_PUSH_TRIES! geq 3 goto :scan_fail
echo [!TS!] main push rejected, pull --rebase + retry (!MAIN_PUSH_TRIES!/3)>> "%LOG%"
goto :main_push_retry
:main_no_change
echo [!TS!] Main repo data push OK>> "%LOG%"

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" --date "!TODAY!" >> "%LOG%" 2>&1
:: 以 daily/<date>.json 是否生成判断增量构建成败（npm errorlevel 不可靠）
if not exist "%SITE_REPO%\daily\!TODAY!.json" (
  echo [!TS!] daily/!TODAY!.json missing after incremental build, treat as FAIL>> "%LOG%"
  goto :scan_fail
)
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" >> "%LOG%" 2>&1
:: 全量重算（density/meta）即便因无关 stderr 返回非 0 也不致命：daily 已生成即核心交付达成，仅记 warning
if !errorlevel! neq 0 echo [!TS!] WARN: full build returned non-zero (likely harmless python stderr), daily already built>> "%LOG%"

cd /d "%SITE_REPO%"
git add daily\ series\ meta.json *.json
git diff --cached --quiet
if !errorlevel! equ 0 goto :site_no_change
git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
:site_push_retry
git pull --rebase --quiet >> "%LOG%" 2>&1
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! equ 0 goto :site_no_change
set /a SITE_PUSH_TRIES+=1
if !SITE_PUSH_TRIES! geq 3 goto :scan_fail
echo [!TS!] site push rejected, pull --rebase + retry (!SITE_PUSH_TRIES!/3)>> "%LOG%"
goto :site_push_retry
:site_no_change
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] ===== market-watch done (target=!TODAY!) =====>> "%LOG%"
exit /b 0

:verify_setup
:: VERIFY 模式：用假 raw 占位（不调网络、不真扫）跑真实 diff/candidates，
:: 复用与真实模式完全相同的产物检查（if not exist ... goto :scan_fail）。
:: 目的：让 cmd 自身成为测试对象，避免 cmd 改了而外部 verify 脚本没同步的漂移。
:: 不碰真实 data、不 git push、不 build。
cd /d "%MAIN_REPO%"
set TODAY=%TARGET_DATE%
set WLDIR=%TEMP%\mw_verify_%RANDOM%
powershell -NoProfile -Command "$d='%WLDIR%'; New-Item -ItemType Directory -Force -Path \"$d\raw\" | Out-Null; $base=(Get-Date '%TODAY%').AddDays(-1).ToString('yyyy-MM-dd'); function fr($dt,$up){@{scan_date=$dt; stocks=@{'000001'=@{name='T'; reason_list=@(@{timestamp=[DateTime]::Parse($dt+'T00:00:00+08:00').Ticks; description=$(if($up){'收盘价10元，涨幅5%'}else{'收盘价10元，跌幅5%'})}; range_reason_list=@()})}} | ConvertTo-Json -Depth 10}; Set-Content \"$d\raw\$base.json\" (fr $base $false); Set-Content \"$d\raw\%TODAY%.json\" (fr $TODAY $true); Set-Content \"$d\universe.json\" '{\"total\":5000}'"
set WATCHLIST_DIR=%WLDIR%
set SCAN_EXIT=0
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] VERIFY mode: 假 raw 占位走 diff/candidates 产物契约检查>> "%LOG%"
goto :diff_stage

:already_done
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] Skip: !TODAY! data already exists>> "%LOG%"
exit /b 0

:fresh_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] Skip: freshness check failed missing raw=!TODAY!>> "%LOG%"
exit /b 0

:git_pull_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] git pull FAILED (rc=!errorlevel!), abort to avoid scanning stale code>> "%LOG%"
exit /b 1

:syntax_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] snapshot.py syntax check FAILED, abort (avoid scanning with broken code)>> "%LOG%"
exit /b 1

:scan_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] scan FAILED (exit=!SCAN_EXIT!, target=!TODAY!)>> "%LOG%"
exit /b 1
