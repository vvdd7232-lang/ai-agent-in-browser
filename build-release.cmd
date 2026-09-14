@echo off
setlocal EnableExtensions

rem RelayBridge one-click Windows x64 build. Run from a Developer Command Prompt/PowerShell for VS 2022.
set "ROOT=%~dp0"
set "BUILD=%ROOT%build"
set "RELEASE=%ROOT%release"

echo.
echo === Configuring RelayBridge ===
where cmake >nul 2>nul
if errorlevel 1 (
    echo [ERROR] CMake was not found. Open "Developer PowerShell for VS 2022" and run this file again.
    exit /b 1
)

cmake -S "%ROOT%" -B "%BUILD%" -G "Visual Studio 17 2022" -A x64 -DRELAY_BUILD_TESTS=ON
if errorlevel 1 goto :failed

echo.
echo === Building RelayBridge.exe ===
cmake --build "%BUILD%" --config Release --parallel --target RelayBridge relay_protocol_tests
if errorlevel 1 goto :failed

echo.
echo === Testing protocol parser ===
ctest --test-dir "%BUILD%" -C Release --output-on-failure
if errorlevel 1 goto :failed

set "EXE="
for /r "%BUILD%" %%F in (RelayBridge.exe) do (
    set "EXE=%%~fF"
    goto :foundExe
)

:foundExe
if not defined EXE (
    echo [ERROR] Build finished but RelayBridge.exe was not found.
    exit /b 1
)

if not exist "%RELEASE%" mkdir "%RELEASE%"
copy /Y "%EXE%" "%RELEASE%\RelayBridge.exe" >nul
copy /Y "%ROOT%README.md" "%RELEASE%\README.md" >nul
powershell.exe -NoProfile -Command "Compress-Archive -Path '%RELEASE%\RelayBridge.exe','%RELEASE%\README.md' -DestinationPath '%RELEASE%\RelayBridge-windows-x64.zip' -Force"
if errorlevel 1 goto :failed

echo.
echo =============================================
echo Done: %RELEASE%RelayBridge.exe
echo ZIP:  %RELEASE%RelayBridge-windows-x64.zip
echo =============================================
exit /b 0

:failed
echo.
echo [ERROR] Build stopped. Read the message above.
exit /b 1
