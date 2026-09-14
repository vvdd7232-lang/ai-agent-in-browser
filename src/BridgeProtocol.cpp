#include "BridgeProtocol.h"

#include <algorithm>
#include <cwctype>
#include <limits>
#include <sstream>
#include <vector>

namespace relay {
namespace {

std::wstring trim(std::wstring_view value) {
    std::size_t first = 0;
    while (first < value.size() && std::iswspace(value[first])) {
        ++first;
    }

    std::size_t last = value.size();
    while (last > first && std::iswspace(value[last - 1])) {
        --last;
    }
    return std::wstring(value.substr(first, last - first));
}

std::wstring normaliseNewlines(std::wstring_view text) {
    std::wstring result;
    result.reserve(text.size());
    for (wchar_t ch : text) {
        if (ch != L'\r') {
            result.push_back(ch);
        }
    }
    return result;
}

bool isValidId(std::wstring_view id) {
    if (id.empty() || id.size() > 64) {
        return false;
    }
    for (const wchar_t ch : id) {
        const bool allowed = std::iswalnum(ch) || ch == L'-' || ch == L'_' || ch == L'.';
        if (!allowed) {
            return false;
        }
    }
    return true;
}

bool parseTimeout(std::wstring_view value, unsigned int& result) {
    const std::wstring cleaned = trim(value);
    if (cleaned.empty()) {
        return false;
    }

    unsigned long long parsed = 0;
    for (const wchar_t ch : cleaned) {
        if (ch < L'0' || ch > L'9') {
            return false;
        }
        parsed = parsed * 10 + static_cast<unsigned long long>(ch - L'0');
        if (parsed > std::numeric_limits<unsigned int>::max()) {
            return false;
        }
    }

    if (parsed == 0 || parsed > kMaximumTimeoutSeconds) {
        return false;
    }
    result = static_cast<unsigned int>(parsed);
    return true;
}

struct Envelope {
    bool found = false;
    std::wstring body;
};

Envelope extractEnvelope(std::wstring_view source) {
    const std::wstring text = normaliseNewlines(source);
    constexpr std::wstring_view openTag = L"<relay-command>";
    constexpr std::wstring_view closeTag = L"</relay-command>";

    const std::size_t taggedStart = text.find(openTag);
    if (taggedStart != std::wstring::npos) {
        const std::size_t bodyStart = taggedStart + openTag.size();
        const std::size_t end = text.find(closeTag, bodyStart);
        if (end == std::wstring::npos) {
            return {true, L""};
        }
        return {true, text.substr(bodyStart, end - bodyStart)};
    }

    constexpr std::wstring_view fence = L"```relay-command";
    const std::size_t fencedStart = text.find(fence);
    if (fencedStart == std::wstring::npos) {
        return {};
    }

    const std::size_t firstNewline = text.find(L'\n', fencedStart + fence.size());
    if (firstNewline == std::wstring::npos) {
        return {true, L""};
    }
    const std::size_t end = text.find(L"\n```", firstNewline + 1);
    if (end == std::wstring::npos) {
        return {true, L""};
    }
    return {true, text.substr(firstNewline + 1, end - firstNewline - 1)};
}

std::wstring takeOneLine(std::wstring_view body, std::size_t& cursor) {
    if (cursor >= body.size()) {
        return {};
    }
    const std::size_t end = body.find(L'\n', cursor);
    if (end == std::wstring::npos) {
        std::wstring line(body.substr(cursor));
        cursor = body.size();
        return line;
    }
    std::wstring line(body.substr(cursor, end - cursor));
    cursor = end + 1;
    return line;
}

std::wstring shorten(std::wstring_view text, std::size_t maximum) {
    if (text.size() <= maximum) {
        return std::wstring(text);
    }
    return std::wstring(text.substr(0, maximum)) + L"\n[output truncated by RelayBridge]";
}

} // namespace

ProtocolResult parseCommand(std::wstring_view text) {
    const Envelope envelope = extractEnvelope(text);
    if (!envelope.found) {
        return {false, {}, L"No <relay-command> envelope was found in the clipboard."};
    }
    if (trim(envelope.body).empty()) {
        return {false, {}, L"The relay-command envelope is incomplete or empty."};
    }

    CommandSpec spec;
    bool sawId = false;
    bool sawCommand = false;
    std::size_t cursor = 0;

    while (cursor < envelope.body.size()) {
        const std::wstring rawLine = takeOneLine(envelope.body, cursor);
        const std::wstring line = trim(rawLine);
        if (line.empty() || line[0] == L'#') {
            continue;
        }

        const std::size_t colon = line.find(L':');
        if (colon == std::wstring::npos) {
            return {false, {}, L"Expected a key:value line before command:."};
        }

        const std::wstring key = trim(std::wstring_view(line).substr(0, colon));
        const std::wstring value = trim(std::wstring_view(line).substr(colon + 1));
        if (key == L"id") {
            if (sawId || !isValidId(value)) {
                return {false, {}, L"id must be unique in the envelope and use only letters, digits, dot, dash, or underscore."};
            }
            spec.id = value;
            sawId = true;
        } else if (key == L"cwd") {
            if (value.empty()) {
                return {false, {}, L"cwd cannot be empty."};
            }
            spec.cwd = value;
        } else if (key == L"timeout") {
            if (!parseTimeout(value, spec.timeoutSeconds)) {
                return {false, {}, L"timeout must be a whole number from 1 to 900 seconds."};
            }
        } else if (key == L"command") {
            if (sawCommand) {
                return {false, {}, L"Only one command: field is allowed."};
            }
            sawCommand = true;
            if (value == L"|" || value.empty()) {
                spec.command = std::wstring(envelope.body.substr(cursor));
            } else {
                spec.command = value;
            }
            break;
        } else {
            return {false, {}, L"Unknown field '" + key + L"'. Allowed fields: id, cwd, timeout, command."};
        }
    }

    spec.command = trim(spec.command);
    if (!sawId) {
        return {false, {}, L"A command needs an id field."};
    }
    if (!sawCommand || spec.command.empty()) {
        return {false, {}, L"A command needs a non-empty command field."};
    }
    if (spec.command.size() > kMaximumCommandCharacters) {
        return {false, {}, L"The command is longer than the 30,000 character limit."};
    }

    return {true, std::move(spec), L""};
}

std::wstring formatResult(
    std::wstring_view id,
    unsigned long exitCode,
    bool timedOut,
    std::wstring_view output,
    bool outputWasTruncated) {
    std::wostringstream message;
    message << L"<relay-result>\n";
    message << L"id: " << id << L"\n";
    message << L"exit_code: " << exitCode << L"\n";
    message << L"timed_out: " << (timedOut ? L"true" : L"false") << L"\n";
    message << L"output_truncated: " << (outputWasTruncated ? L"true" : L"false") << L"\n";
    message << L"output:\n";
    message << shorten(output, 60'000) << L"\n";
    message << L"</relay-result>";
    return message.str();
}

std::wstring makeAgentPrompt(std::wstring_view workspacePath) {
    const std::wstring_view displayedWorkspace = workspacePath.empty()
        ? L"NOT SET — ask the user to choose a workspace before issuing a command"
        : workspacePath;
    std::wostringstream prompt;
    prompt << L"You are working with RelayBridge, a local Windows terminal bridge. "
           << L"You can ask it to run commands, but you do not directly have a terminal. "
           << L"The user has selected this workspace: " << displayedWorkspace << L".\n\n"
           << L"When a terminal action is needed, reply with exactly one command envelope and no prose after it:\n"
           << L"<relay-command>\n"
           << L"id: short-unique-id\n"
           << L"cwd: .\n"
           << L"timeout: 120\n"
           << L"command: |\n"
           << L"  your Windows cmd.exe command here\n"
           << L"</relay-command>\n\n"
           << L"The user will copy your reply. RelayBridge will execute it inside the selected workspace and return a "
           << L"<relay-result> message. Inspect that result before deciding the next command. "
           << L"Use relative cwd values only. Keep commands focused, do not use administrator privileges, and never claim "
           << L"that a command ran until you receive its relay-result. For explanations that need no command, answer normally.";
    return prompt.str();
}

} // namespace relay
