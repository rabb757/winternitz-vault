@echo off
rem One pass of the auto-migrator. Scheduled rather than long-lived: a process
rem that dies quietly at 4am is worse than one that simply runs again.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0auto-migrate.ts" >> "%~dp0migrator.log" 2>&1
