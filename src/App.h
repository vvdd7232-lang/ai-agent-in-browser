#pragma once

#include "BridgeProtocol.h"
#include "Settings.h"

#include <windows.h>

#include <memory>
#include <string>

namespace relay {

struct ExecutionCompletion;

class App {
public:
    explicit App(HINSTANCE instance);
    int run(int showCommand);

private:
    static constexpr UINT kExecuteCompletedMessage = WM_APP + 17;

    enum ControlId : int {
        IdWorkspace = 100,
        IdBrowseWorkspace,
        IdChatUrl,
        IdOpenChat,
        IdClipboardBridge,
        IdRequireApproval,
        IdCopyPrompt,
        IdRunClipboard,
        IdCopyResult,
        IdClearOutput,
        IdPrompt,
        IdOutput
    };

    HINSTANCE instance_ = nullptr;
    HWND window_ = nullptr;
    HFONT normalFont_ = nullptr;
    HFONT boldFont_ = nullptr;
    SettingsStore settingsStore_;
    Settings settings_;

    HWND workspaceEdit_ = nullptr;
    HWND chatUrlEdit_ = nullptr;
    HWND clipboardBridgeCheck_ = nullptr;
    HWND approvalCheck_ = nullptr;
    HWND promptEdit_ = nullptr;
    HWND outputEdit_ = nullptr;
    HWND statusText_ = nullptr;
    HWND runClipboardButton_ = nullptr;
    HWND copyResultButton_ = nullptr;

    bool executing_ = false;
    std::wstring lastResult_;
    std::wstring ignoredClipboardText_;

    static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);
    LRESULT handleMessage(UINT message, WPARAM wParam, LPARAM lParam);

    bool createControls();
    void layoutControls(int width, int height);
    void handleCommand(WORD controlId, WORD notificationCode);
    void captureClipboardCommand(bool initiatedManually);
    void acceptCommand(CommandSpec command, bool initiatedManually);
    void executeAsync(CommandSpec command, const std::wstring& resolvedWorkingDirectory);
    void completeExecution(std::unique_ptr<ExecutionCompletion> completion);

    void browseWorkspace();
    void openChat();
    void refreshPrompt();
    void syncSettingsFromControls();
    void updateBridgeStatus();
    void setStatus(const std::wstring& text, bool isProblem = false);
    void appendOutput(const std::wstring& text);
    void setOutput(const std::wstring& text);
    void setExecuting(bool executing);
    void copyTextToClipboard(const std::wstring& text);
    std::wstring clipboardText() const;
    std::wstring windowText(HWND control) const;

    static ATOM registerWindowClass(HINSTANCE instance);
};

} // namespace relay
