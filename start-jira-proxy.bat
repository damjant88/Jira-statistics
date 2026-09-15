@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0jira-proxy.js"
if errorlevel 1 (
    echo.
    echo The proxy exited with an error. Press any key to close.
    pause >nul
)
