@echo off
REM Thin wrapper — the real setup is in TypeScript for cross-platform support.
npx tsx "%~dp0setup.ts" %*
