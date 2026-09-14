#include "CommandRunner.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cwctype>
#include <filesystem>
#include <string>
#include <vector>

namespace relay {
namespace {

constexpr std::size_t kMaximumCapturedBytes = 120'000;

std::wstring systemMessage(DWORD error) {
    LPWSTR buffer = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        error,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<LPWSTR>(&buffer),
        0,
        nullptr);

    std::wstring message = length > 0 && buffer != nullptr ? std::wstring(buffer, length) : L"Unknown Windows error";
    if (buffer != nullptr) {
        LocalFree(buffer);
    }
    while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n')) {
        message.pop_back();
    }
    return message;
}

std::wstring bytesToWide(const std::string& bytes) {
    if (bytes.empty()) {
        return {};
    }

    const auto convert = [&bytes](UINT codePage, DWORD flags) -> std::wstring {
        const int required = MultiByteToWideChar(codePage, flags, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
        if (required <= 0) {
            return {};
        }
        std::wstring wide(static_cast<std::size_t>(required), L'\0');
        MultiByteToWideChar(codePage, flags, bytes.data(), static_cast<int>(bytes.size()), wide.data(), required);
        return wide;
    };

    std::wstring utf8 = convert(CP_UTF8, MB_ERR_INVALID_CHARS);
    if (!utf8.empty()) {
        return utf8;
    }
    std::wstring oem = convert(CP_OEMCP, 0);
    return oem.empty() ? L"[RelayBridge could not decode command output]" : oem;
}

bool pathIsInside(const std::filesystem::path& root, const std::filesystem::path& candidate) {
    auto rootIt = root.begin();
    auto candidateIt = candidate.begin();
    for (; rootIt != root.end() && candidateIt != candidate.end(); ++rootIt, ++candidateIt) {
        std::wstring left = rootIt->wstring();
        std::wstring right = candidateIt->wstring();
        if (left.size() != right.size() || !std::equal(left.begin(), left.end(), right.begin(), [](wchar_t a, wchar_t b) {
                return towlower(a) == towlower(b);
            })) {
            return false;
        }
    }
    return rootIt == root.end();
}

void drainPipe(HANDLE readPipe, std::string& bytes, bool& truncated) {
    for (;;) {
        DWORD available = 0;
        if (!PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr) || available == 0) {
            return;
        }

        std::array<char, 4096> buffer{};
        DWORD bytesRead = 0;
        const DWORD toRead = std::min<DWORD>(available, static_cast<DWORD>(buffer.size()));
        if (!ReadFile(readPipe, buffer.data(), toRead, &bytesRead, nullptr) || bytesRead == 0) {
            return;
        }

        if (bytes.size() < kMaximumCapturedBytes) {
            const std::size_t remaining = kMaximumCapturedBytes - bytes.size();
            const std::size_t accepted = std::min<std::size_t>(remaining, bytesRead);
            bytes.append(buffer.data(), accepted);
            if (accepted < bytesRead) {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }
}

} // namespace

bool resolveWorkingDirectory(
    const std::wstring& workspaceRoot,
    const std::wstring& requestedCwd,
    std::wstring& resolvedPath,
    std::wstring& error) {
    try {
        if (workspaceRoot.empty()) {
            error = L"Choose a workspace folder before executing a command.";
            return false;
        }

        const std::filesystem::path rootInput(workspaceRoot);
        if (!std::filesystem::exists(rootInput) || !std::filesystem::is_directory(rootInput)) {
            error = L"The selected workspace folder does not exist.";
            return false;
        }

        const std::filesystem::path root = std::filesystem::weakly_canonical(rootInput);
        std::filesystem::path candidate(requestedCwd.empty() ? L"." : requestedCwd);
        if (candidate.is_relative()) {
            candidate = root / candidate;
        }
        candidate = std::filesystem::weakly_canonical(candidate);

        if (!std::filesystem::exists(candidate) || !std::filesystem::is_directory(candidate)) {
            error = L"The requested cwd does not exist or is not a directory: " + candidate.wstring();
            return false;
        }
        if (!pathIsInside(root, candidate)) {
            error = L"The requested cwd is outside the selected workspace. Choose a folder inside the workspace instead.";
            return false;
        }

        resolvedPath = candidate.wstring();
        return true;
    } catch (const std::filesystem::filesystem_error& exception) {
        const std::string raw = exception.what();
        resolvedPath.clear();
        error.assign(raw.begin(), raw.end());
        return false;
    }
}

ExecutionResult runCommand(const CommandSpec& command, const std::wstring& resolvedWorkingDirectory) {
    ExecutionResult result;

    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;

    HANDLE readPipe = nullptr;
    HANDLE writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &attributes, 0)) {
        result.launchError = L"CreatePipe failed: " + systemMessage(GetLastError());
        return result;
    }
    if (!SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0)) {
        result.launchError = L"SetHandleInformation failed: " + systemMessage(GetLastError());
        CloseHandle(readPipe);
        CloseHandle(writePipe);
        return result;
    }

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job != nullptr) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limitInfo{};
        limitInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limitInfo, sizeof(limitInfo));
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = writePipe;
    startup.hStdError = writePipe;

    PROCESS_INFORMATION process{};
    // cmd.exe receives the exact requested command as the remainder of /c.
    std::wstring commandLine = L"cmd.exe /d /s /c " + command.command;
    std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
    mutableCommandLine.push_back(L'\0');

    const BOOL created = CreateProcessW(
        nullptr,
        mutableCommandLine.data(),
        nullptr,
        nullptr,
        TRUE,
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
        nullptr,
        resolvedWorkingDirectory.c_str(),
        &startup,
        &process);
    CloseHandle(writePipe);

    if (!created) {
        result.launchError = L"Could not start cmd.exe: " + systemMessage(GetLastError());
        CloseHandle(readPipe);
        if (job != nullptr) {
            CloseHandle(job);
        }
        return result;
    }

    if (job != nullptr && !AssignProcessToJobObject(job, process.hProcess)) {
        // A host can already place this app in a job. The command still runs; timeout then terminates cmd.exe.
        CloseHandle(job);
        job = nullptr;
    }

    std::string captured;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(command.timeoutSeconds);
    bool processFinished = false;
    while (!processFinished) {
        drainPipe(readPipe, captured, result.outputWasTruncated);
        const DWORD wait = WaitForSingleObject(process.hProcess, 50);
        if (wait == WAIT_OBJECT_0) {
            processFinished = true;
            break;
        }
        if (wait == WAIT_FAILED) {
            result.launchError = L"Unable to wait for cmd.exe: " + systemMessage(GetLastError());
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            result.timedOut = true;
            if (job != nullptr) {
                TerminateJobObject(job, ERROR_TIMEOUT);
            } else {
                TerminateProcess(process.hProcess, ERROR_TIMEOUT);
            }
            WaitForSingleObject(process.hProcess, 2'000);
            processFinished = true;
        }
    }

    drainPipe(readPipe, captured, result.outputWasTruncated);
    DWORD exitCode = 1;
    if (GetExitCodeProcess(process.hProcess, &exitCode)) {
        result.exitCode = exitCode;
    } else if (result.timedOut) {
        result.exitCode = ERROR_TIMEOUT;
    } else {
        result.launchError = L"Unable to read the process exit code: " + systemMessage(GetLastError());
    }

    result.output = bytesToWide(captured);
    if (result.output.empty() && result.timedOut) {
        result.output = L"[RelayBridge stopped this command because it exceeded its timeout.]";
    }

    CloseHandle(readPipe);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    if (job != nullptr) {
        CloseHandle(job);
    }
    return result;
}

} // namespace relay
