@echo off
setlocal enabledelayedexpansion
set MAIN_REPO=C:\workspace\trend-trading-agents
set SITE_REPO=C:\workspace\market-watch
set LOG=C:\workspace\market-watch.log
set XUEQIU_TOKEN=XqTestfa1d5be488e0182c10b3f36b6929a7f025e370a8
set FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/6737012e-c4f8-4a61-a952-7b1132cfc6e9
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
if "!DATA_DATE!"=="!TODAY!" (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
  echo [!TS!] Skip: !TODAY! data already exists =!DATA_DATE!>> "%LOG%"
  exit /b 0
)

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] git pull>> "%LOG%"
git checkout -- . 2>nul
git clean -fdq 2>nul
git pull --rebase --quiet >> "%LOG%" 2>&1

:: --- ??? API ???????????? UA + ???????? IP ???????????????---
set XUEQIU_UA=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36
set API_TRIES=0
:api_retry
set /a API_TRIES+=1
if exist "C:\workspace\api_check.txt" del "C:\workspace\api_check.txt"
node -e "const https=require('https');const t='%XUEQIU_TOKEN%';https.get('https://xueqiu.com/rainbow/ai/abnormal/reasons.json',{headers:{'Cookie':'xq_a_token='+t,'User-Agent':'%XUEQIU_UA%','Host':'xueqiu.com'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);console.log(j.code);process.exit(j.code===200?0:1)}catch{process.exit(1)}})}).on('error',()=>process.exit(1))" > C:\workspace\api_check.txt 2>&1
set API_STATUS=
if exist "C:\workspace\api_check.txt" set /p API_STATUS=<C:\workspace\api_check.txt
if "!API_STATUS!"=="200" goto :api_ok
if !API_TRIES! lss 3 (
  echo [!TS!] API check attempt !API_TRIES! returned !API_STATUS!, retry in 20s>> "%LOG%"
  timeout /t 20 /nobreak >nul
  goto :api_retry
)
:api_fail
echo [!TS!] API check FAILED after !API_TRIES! attempts (status !API_STATUS!)>> "%LOG%"
powershell -NoProfile -Command "Invoke-RestMethod -Uri '%FEISHU_WEBHOOK%' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] Xueqiu API blocked! Status: !API_STATUS!. Please solve captcha at xueqiu.com.\"}}'"
exit /b 1
:api_ok
echo [!TS!] API check passed>> "%LOG%"

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] scan-all (--date !TODAY! --sleep !SLEEP!, hard timeout 3h)>> "%LOG%"
set SCAN_RC_FILE=%MAIN_REPO%\scan_rc.tmp
if exist "%SCAN_RC_FILE%" del /q "%SCAN_RC_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'C:\Program Files\nodejs\npm.cmd' -ArgumentList 'run','scan-all','--','--date','!TODAY!','--sleep','!SLEEP!' -WorkingDirectory '%MAIN_REPO%' -NoNewWindow -PassThru -RedirectStandardOutput '%MAIN_REPO%\scan_out.tmp' -RedirectStandardError '%MAIN_REPO%\scan_err.tmp'; if ($p.WaitForExit(10800000)) { $code = $p.ExitCode } else { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Get-Process node,python -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; $code = 1 }; Set-Content -Path '%SCAN_RC_FILE%' -Value $code -Encoding Ascii"
type "%MAIN_REPO%\scan_out.tmp" >> "%LOG%" 2>nul
type "%MAIN_REPO%\scan_err.tmp" >> "%LOG%" 2>nul
set SCAN_EXIT=1
if exist "%SCAN_RC_FILE%" for /f "delims=" %%r in (%SCAN_RC_FILE%) do set SCAN_EXIT=%%r

:: --- ??????scan-all errorlevel ?????? Node.js ???????????????? 0 ---
:: ???????? raw ????????????????
set /a RAW_RETRY=0
:raw_check
if exist "%MAIN_REPO%\data\watchlist\raw\!TODAY!.json" goto :real_scan_ok
set /a RAW_RETRY+=1
if !RAW_RETRY! leq 6 (timeout /t 5 /nobreak >nul & goto :raw_check)
if !SCAN_EXIT! neq 0 (
  echo [!TS!] scan-all exited !SCAN_EXIT! and raw missing=!TODAY!>> "%LOG%"
) else (
  echo [!TS!] scan-all raw missing=!TODAY! (exit=0)>> "%LOG%"
)
goto :scan_fail

:scan_fail
echo [!TS!] scan-all FAILED (exit=!SCAN_EXIT!, missing raw=!TODAY!)>> "%LOG%"
powershell -NoProfile -Command "Invoke-RestMethod -Uri '%FEISHU_WEBHOOK%' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] scan-all failed! Missing data: !TODAY!. Check log at C:\\workspace\\market-watch.log\"}}'"
exit /b 1
:real_scan_ok

echo [!TS!] scan-all OK>> "%LOG%"

if not exist "%MAIN_REPO%\data\watchlist\raw\!TODAY!.json" (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
  echo [!TS!] Skip: freshness check failed missing raw=!TODAY!>> "%LOG%"
  exit /b 0
)

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] Freshness OK: !TODAY!>> "%LOG%"

echo [!TS!] Push main repo data...>> "%LOG%"
cd /d "%MAIN_REPO%"
git add data\
git diff --cached --quiet
if !errorlevel! equ 0 (
  echo [!TS!] Main repo data no change, skip push>> "%LOG%"
) else (
  git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
  git push --quiet >> "%LOG%" 2>&1
  if !errorlevel! neq 0 (
    echo [!TS!] Main repo git push FAILED (rc=!errorlevel!)>> "%LOG%"
    powershell -NoProfile -Command "Invoke-RestMethod -Uri '!FEISHU_WEBHOOK!' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] !TODAY! main repo git push FAILED (rc=!errorlevel!). Check log.\"}}'"
    exit /b 1
  )
)

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" --date "!TODAY!" >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] build:report (--date) FAILED (rc=!errorlevel!)>> "%LOG%"
  powershell -NoProfile -Command "Invoke-RestMethod -Uri '!FEISHU_WEBHOOK!' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] !TODAY! build:report (--date) FAILED (rc=!errorlevel!). Check log.\"}}'"
  exit /b 1
)
call npm run build:report -- --in data/watchlist --out "%SITE_REPO%" >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] build:report (full) FAILED (rc=!errorlevel!)>> "%LOG%"
  powershell -NoProfile -Command "Invoke-RestMethod -Uri '!FEISHU_WEBHOOK!' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] !TODAY! build:report (full) FAILED (rc=!errorlevel!). Check log.\"}}'"
  exit /b 1
)

cd /d "%SITE_REPO%"
git add daily\ series\ meta.json *.json
git diff --cached --quiet
if !errorlevel! equ 0 (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
  echo [!TS!] No data change, skip push>> "%LOG%"
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'") do set TS=%%a
  echo [!TS!] ===== market-watch done, no change (target=!TODAY!) =====>> "%LOG%"
  powershell -NoProfile -Command "Invoke-RestMethod -Uri '!FEISHU_WEBHOOK!' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] !TODAY! done (no data change). Skipped push. C:\workspace\market-watch.log\"}}'"
  exit /b 0
)
git commit -m "data: !TODAY!" --quiet >> "%LOG%" 2>&1
git push --quiet >> "%LOG%" 2>&1
if !errorlevel! neq 0 (
  echo [!TS!] Site repo git push FAILED (rc=!errorlevel!)>> "%LOG%"
  powershell -NoProfile -Command "Invoke-RestMethod -Uri '!FEISHU_WEBHOOK!' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] !TODAY! site repo git push FAILED (rc=!errorlevel!). Likely remote ahead - manual pull/rebase needed. Check log.\"}}'"
  exit /b 1
)

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set TS=%%a
echo [!TS!] ===== market-watch done (target=!TODAY!) =====>> "%LOG%"

powershell -NoProfile -Command "Invoke-RestMethod -Uri '!FEISHU_WEBHOOK!' -Method Post -ContentType 'application/json' -Body '{\"msg_type\":\"text\",\"content\":{\"text\":\"[MarketWatch] !TODAY! OK. Scan+build+push completed successfully. C:\workspace\market-watch.log\"}}'"

exit /b 0
