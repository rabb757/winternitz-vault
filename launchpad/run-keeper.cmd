@echo off
rem Migrates finished curves and sweeps the platform fees into the vault.
rem Both are things nobody on chain does for you.
cd /d "%~dp0"
set NODE="C:\Program Files\nodejs\node.exe"
set TSX=%~dp0node_modules\tsx\dist\cli.mjs
%NODE% "%TSX%" "%~dp0auto-migrate.ts" >> "%~dp0keeper.log" 2>&1
set LIVE=1
%NODE% "%TSX%" "%~dp0claim-to-vault.ts" >> "%~dp0keeper.log" 2>&1
