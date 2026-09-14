#include "BridgeProtocol.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

} // namespace

int main() {
    using relay::parseCommand;

    const auto normal = parseCommand(
        L"I will inspect the project.\n"
        L"<relay-command>\n"
        L"id: inspect-01\n"
        L"cwd: src\n"
        L"timeout: 45\n"
        L"command: |\n"
        L"  dir /b\n"
        L"  echo done\n"
        L"</relay-command>");
    require(normal.ok, "valid XML envelope should parse");
    require(normal.command.id == L"inspect-01", "ID should be preserved");
    require(normal.command.cwd == L"src", "cwd should be preserved");
    require(normal.command.timeoutSeconds == 45, "timeout should be parsed");
    require(normal.command.command == L"dir /b\n  echo done", "multiline command should be preserved and trimmed");

    const auto fenced = parseCommand(
        L"```relay-command\n"
        L"id: one\n"
        L"command: echo hello\n"
        L"```\n");
    require(fenced.ok, "fenced envelope should parse");
    require(fenced.command.cwd == L".", "cwd defaults to workspace root");
    require(fenced.command.timeoutSeconds == relay::kDefaultTimeoutSeconds, "timeout defaults correctly");

    const auto badTimeout = parseCommand(
        L"<relay-command>\n"
        L"id: too-long\n"
        L"timeout: 901\n"
        L"command: echo nope\n"
        L"</relay-command>");
    require(!badTimeout.ok, "timeout above cap should fail");

    const auto unknownField = parseCommand(
        L"<relay-command>\n"
        L"id: no-field\n"
        L"shell: powershell\n"
        L"command: echo nope\n"
        L"</relay-command>");
    require(!unknownField.ok, "unknown fields should fail closed");

    const auto noId = parseCommand(
        L"<relay-command>\n"
        L"command: echo nope\n"
        L"</relay-command>");
    require(!noId.ok, "ID should be mandatory");

    const std::wstring result = relay::formatResult(L"inspect-01", 0, false, L"two files", false);
    require(result.find(L"<relay-result>") != std::wstring::npos, "result should use relay-result envelope");
    require(result.find(L"exit_code: 0") != std::wstring::npos, "result should include exit code");

    const std::wstring prompt = relay::makeAgentPrompt(L"C:\\Projects\\demo");
    require(prompt.find(L"<relay-command>") != std::wstring::npos, "agent prompt should teach protocol");
    require(prompt.find(L"C:\\Projects\\demo") != std::wstring::npos, "agent prompt should name workspace");

    std::cout << "All protocol tests passed.\n";
    return 0;
}
