@echo off
setlocal enabledelayedexpansion
set MAIN_REPO=C:\workspace\trend-trading-agents
set SITE_REPO=C:\workspace\market-watch
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


for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] snapshot (python -u, realtime log scan_live_!TODAY!.log, hard timeout 3h)>> "%LOG%"
set SCAN_RC_FILE=%MAIN_REPO%\scan_rc.tmp
if exist "%SCAN_RC_FILE%" del /q "%SCAN_RC_FILE%"
set SCAN_OUT=%MAIN_REPO%\scan_live_!TODAY!.out
set SCAN_ERR=%MAIN_REPO%\scan_live_!TODAY!.err
if exist "%SCAN_OUT%" del /q "%SCAN_OUT%"
if exist "%SCAN_ERR%" del /q "%SCAN_ERR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%MAIN_REPO%\.venv\Scripts\python.exe' -ArgumentList '-u','%MAIN_REPO%\skills\watchlist\scripts\snapshot.py','--date','!TODAY!','--concurrency','2','--sleep','!SLEEP!' -WorkingDirectory '%MAIN_REPO%' -NoNewWindow -PassThru -RedirectStandardOutput '%SCAN_OUT%' -RedirectStandardError '%SCAN_ERR%'; if ($p.WaitForExit(10800000)) { $code = $p.ExitCode } else { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; $code = 1 }; Set-Content -Path '%SCAN_RC_FILE%' -Value $code -Encoding Ascii"
type "%SCAN_OUT%" >> "%LOG%" 2>nul
type "%SCAN_ERR%" >> "%LOG%" 2>nul
set SCAN_EXIT=1
if exist "%SCAN_RC_FILE%" for /f "delims=" %%r in (%SCAN_RC_FILE%) do set SCAN_EXIT=%%r
if !SCAN_EXIT! neq 0 goto :scan_fail

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] diff (--date !TODAY!)>> "%LOG%"
call npm run diff -- --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :scan_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] candidates (--date !TODAY!)>> "%LOG%"
call npm run candidates -- --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :scan_fail
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] snapshot+diff+candidates OK>> "%LOG%"

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
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :scan_fail
:main_no_change
echo [!TS!] Main repo data push OK>> "%LOG%"

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :scan_fail
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :scan_fail

cd /d "%SITE_REPO%"
git add daily\ series\ meta.json *.json
git diff --cached --quiet
if !errorlevel! equ 0 goto :site_no_change
git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! neq 0 goto :scan_fail
:site_no_change
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] ===== market-watch done (target=!TODAY!) =====>> "%LOG%"
exit /b 0

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
