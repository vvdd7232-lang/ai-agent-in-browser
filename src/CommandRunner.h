#pragma once

#include "BridgeProtocol.h"

#include <string>

namespace relay {

struct ExecutionResult {
    unsigned long exitCode = 1;
    bool timedOut = false;
    bool outputWasTruncated = false;
    std::wstring output;
    std::wstring launchError;
};

// Resolves a command cwd below workspaceRoot. This is a convenience guard, not a sandbox.
bool resolveWorkingDirectory(
    const std::wstring& workspaceRoot,
    const std::wstring& requestedCwd,
    std::wstring& resolvedPath,
    std::wstring& error);

// Starts cmd.exe as the current user and captures its combined stdout/stderr.
ExecutionResult runCommand(const CommandSpec& command, const std::wstring& resolvedWorkingDirectory);

} // namespace relay
