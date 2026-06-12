@echo off
rem Infinite Paper — start the local server, then open the app.
cd /d "%~dp0"
start "" http://127.0.0.1:4321
node server.js
pause
