#pragma once

#include <string>
#include <string_view>

namespace relay {

constexpr unsigned int kDefaultTimeoutSeconds = 120;
constexpr unsigned int kMaximumTimeoutSeconds = 900;
constexpr std::size_t kMaximumCommandCharacters = 30'000;

struct CommandSpec {
    std::wstring id;
    std::wstring cwd = L".";
    std::wstring command;
    unsigned int timeoutSeconds = kDefaultTimeoutSeconds;
};

struct ProtocolResult {
    bool ok = false;
    CommandSpec command;
    std::wstring error;
};

// Parses one command envelope copied from a browser chat.
// Accepted forms are <relay-command>...</relay-command> and a relay-command fenced block.
ProtocolResult parseCommand(std::wstring_view text);

// Produces the message that is copied back to the browser after command execution.
std::wstring formatResult(
    std::wstring_view id,
    unsigned long exitCode,
    bool timedOut,
    std::wstring_view output,
    bool outputWasTruncated);

// The exact startup instruction the desktop app gives to a browser-based model.
std::wstring makeAgentPrompt(std::wstring_view workspacePath);

} // namespace relay
