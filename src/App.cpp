#include "App.h"

#include "CommandRunner.h"

#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <cstring>
#include <iterator>
#include <memory>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

namespace relay {

struct ExecutionCompletion {
    CommandSpec command;
    ExecutionResult result;
};

namespace {

constexpr wchar_t kWindowClassName[] = L"RelayBridge.Window";
constexpr wchar_t kWindowTitle[] = L"RelayBridge — AI browser terminal";

HWND addControl(
    HWND parent,
    const wchar_t* className,
    const wchar_t* text,
    DWORD style,
    int id,
    HFONT font,
    DWORD extendedStyle = 0) {
    HWND control = CreateWindowExW(
        extendedStyle,
        className,
        text,
        style | WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        parent,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
        GetModuleHandleW(nullptr),
        nullptr);
    SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    return control;
}

std::wstring previewForDialog(const std::wstring& command) {
    constexpr std::size_t limit = 6'000;
    if (command.size() <= limit) {
        return command;
    }
    return command.substr(0, limit) + L"\n\n[Command preview shortened]";
}

} // namespace

App::App(HINSTANCE instance) : instance_(instance) {}

ATOM App::registerWindowClass(HINSTANCE instance) {
    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = App::windowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    windowClass.hIconSm = windowClass.hIcon;
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = kWindowClassName;
    return RegisterClassExW(&windowClass);
}

int App::run(int showCommand) {
    INITCOMMONCONTROLSEX controls{};
    controls.dwSize = sizeof(controls);
    controls.dwICC = ICC_STANDARD_CLASSES;
    InitCommonControlsEx(&controls);
    const bool comInitialised = SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED));

    settings_ = settingsStore_.load();
    if (registerWindowClass(instance_) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        MessageBoxW(nullptr, L"RelayBridge could not register its window class.", kWindowTitle, MB_ICONERROR | MB_OK);
        if (comInitialised) {
            CoUninitialize();
        }
        return 1;
    }

    window_ = CreateWindowExW(
        0,
        kWindowClassName,
        kWindowTitle,
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1060,
        780,
        nullptr,
        nullptr,
        instance_,
        this);
    if (window_ == nullptr) {
        MessageBoxW(nullptr, L"RelayBridge could not create the main window.", kWindowTitle, MB_ICONERROR | MB_OK);
        if (comInitialised) {
            CoUninitialize();
        }
        return 1;
    }

    ShowWindow(window_, showCommand);
    UpdateWindow(window_);

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    if (normalFont_ != nullptr) {
        DeleteObject(normalFont_);
    }
    if (boldFont_ != nullptr) {
        DeleteObject(boldFont_);
    }
    if (comInitialised) {
        CoUninitialize();
    }
    return static_cast<int>(message.wParam);
}

LRESULT CALLBACK App::windowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    App* app = reinterpret_cast<App*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const CREATESTRUCTW* create = reinterpret_cast<const CREATESTRUCTW*>(lParam);
        app = static_cast<App*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(app));
        app->window_ = window;
    }
    return app != nullptr ? app->handleMessage(message, wParam, lParam) : DefWindowProcW(window, message, wParam, lParam);
}

LRESULT App::handleMessage(UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE:
        return createControls() ? 0 : -1;

    case WM_SIZE:
        layoutControls(LOWORD(lParam), HIWORD(lParam));
        return 0;

    case WM_GETMINMAXINFO: {
        auto* minMax = reinterpret_cast<MINMAXINFO*>(lParam);
        minMax->ptMinTrackSize.x = 840;
        minMax->ptMinTrackSize.y = 690;
        return 0;
    }

    case WM_COMMAND:
        handleCommand(LOWORD(wParam), HIWORD(wParam));
        return 0;

    case WM_CLIPBOARDUPDATE:
        if (IsDlgButtonChecked(window_, IdClipboardBridge) == BST_CHECKED) {
            captureClipboardCommand(false);
        }
        return 0;

    case kExecuteCompletedMessage:
        completeExecution(std::unique_ptr<ExecutionCompletion>(reinterpret_cast<ExecutionCompletion*>(lParam)));
        return 0;

    case WM_DESTROY:
        syncSettingsFromControls();
        settingsStore_.save(settings_);
        RemoveClipboardFormatListener(window_);
        PostQuitMessage(0);
        return 0;

    default:
        return DefWindowProcW(window_, message, wParam, lParam);
    }
}

bool App::createControls() {
    normalFont_ = CreateFontW(
        -17, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    boldFont_ = CreateFontW(
        -17, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    if (normalFont_ == nullptr || boldFont_ == nullptr) {
        return false;
    }

    addControl(window_, L"STATIC", L"RelayBridge", SS_LEFT, -1, boldFont_);
    addControl(window_, L"STATIC", L"Browser AI chat ↔ your local cmd.exe, through the clipboard", SS_LEFT, -1, normalFont_);

    addControl(window_, L"STATIC", L"Workspace", SS_LEFT, -1, normalFont_);
    workspaceEdit_ = addControl(window_, L"EDIT", settings_.workspace.c_str(), WS_BORDER | ES_AUTOHSCROLL, IdWorkspace, normalFont_);
    addControl(window_, L"BUTTON", L"Choose…", BS_PUSHBUTTON, IdBrowseWorkspace, normalFont_);

    addControl(window_, L"STATIC", L"Chat URL", SS_LEFT, -1, normalFont_);
    chatUrlEdit_ = addControl(window_, L"EDIT", settings_.chatUrl.c_str(), WS_BORDER | ES_AUTOHSCROLL, IdChatUrl, normalFont_);
    addControl(window_, L"BUTTON", L"Open chat", BS_PUSHBUTTON, IdOpenChat, normalFont_);

    clipboardBridgeCheck_ = addControl(
        window_, L"BUTTON", L"Watch clipboard and accept relay commands", BS_AUTOCHECKBOX, IdClipboardBridge, normalFont_);
    approvalCheck_ = addControl(
        window_, L"BUTTON", L"Ask before every command (recommended)", BS_AUTOCHECKBOX, IdRequireApproval, normalFont_);
    SendMessageW(clipboardBridgeCheck_, BM_SETCHECK, settings_.clipboardBridgeEnabled ? BST_CHECKED : BST_UNCHECKED, 0);
    SendMessageW(approvalCheck_, BM_SETCHECK, settings_.requireApproval ? BST_CHECKED : BST_UNCHECKED, 0);

    addControl(window_, L"BUTTON", L"Copy agent prompt", BS_PUSHBUTTON, IdCopyPrompt, normalFont_);
    runClipboardButton_ = addControl(window_, L"BUTTON", L"Run command from clipboard", BS_PUSHBUTTON, IdRunClipboard, normalFont_);
    addControl(window_, L"BUTTON", L"Clear log", BS_PUSHBUTTON, IdClearOutput, normalFont_);

    addControl(window_, L"STATIC", L"1. Paste this prompt into the browser chat", SS_LEFT, -1, boldFont_);
    promptEdit_ = addControl(
        window_, L"EDIT", L"", WS_BORDER | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY | WS_VSCROLL,
        IdPrompt, normalFont_, WS_EX_CLIENTEDGE);
    SendMessageW(promptEdit_, EM_SETLIMITTEXT, 0, 0);

    addControl(window_, L"STATIC", L"2. Terminal result", SS_LEFT, -1, boldFont_);
    statusText_ = addControl(window_, L"STATIC", L"", SS_LEFT, -1, normalFont_);
    copyResultButton_ = addControl(window_, L"BUTTON", L"Copy last result", BS_PUSHBUTTON, IdCopyResult, normalFont_);
    outputEdit_ = addControl(
        window_, L"EDIT", L"", WS_BORDER | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY | WS_VSCROLL,
        IdOutput, normalFont_, WS_EX_CLIENTEDGE);
    SendMessageW(outputEdit_, EM_SETLIMITTEXT, 0, 0);
    refreshPrompt();
    setOutput(L"Ready. First choose a narrow project workspace, copy the agent prompt into a browser chat, then copy a <relay-command> reply back here.\r\n\r\n"
              L"Safety note: RelayBridge runs commands as your Windows user. Leave approval enabled unless you trust the chat.");

    if (!AddClipboardFormatListener(window_)) {
        setStatus(L"Clipboard monitoring is unavailable on this version of Windows. The manual Run button still works.", true);
    } else {
        updateBridgeStatus();
    }
    return true;
}

void App::layoutControls(int width, int height) {
    const int margin = 18;
    const int right = std::max(margin, width - margin);
    const int labelWidth = 76;
    const int buttonWidth = 112;
    const int editLeft = margin + labelWidth;
    const int editWidth = std::max(160, right - editLeft - buttonWidth - 10);

    const auto moveById = [this](int id, int x, int y, int w, int h) {
        MoveWindow(GetDlgItem(window_, id), x, y, w, h, TRUE);
    };
    const auto moveStaticByText = [this](const wchar_t* text, int occurrence, int x, int y, int w, int h) {
        int seen = 0;
        for (HWND child = GetWindow(window_, GW_CHILD); child != nullptr; child = GetWindow(child, GW_HWNDNEXT)) {
            wchar_t childText[128]{};
            GetWindowTextW(child, childText, static_cast<int>(std::size(childText)));
            if (wcscmp(childText, text) == 0 && seen++ == occurrence) {
                MoveWindow(child, x, y, w, h, TRUE);
                return;
            }
        }
    };

    moveStaticByText(L"RelayBridge", 0, margin, 14, 250, 25);
    moveStaticByText(L"Browser AI chat ↔ your local cmd.exe, through the clipboard", 0, margin, 39, right - margin, 22);

    moveStaticByText(L"Workspace", 0, margin, 78, labelWidth - 4, 25);
    moveById(IdWorkspace, editLeft, 74, editWidth, 29);
    moveById(IdBrowseWorkspace, editLeft + editWidth + 10, 74, buttonWidth, 29);

    moveStaticByText(L"Chat URL", 0, margin, 116, labelWidth - 4, 25);
    moveById(IdChatUrl, editLeft, 112, editWidth, 29);
    moveById(IdOpenChat, editLeft + editWidth + 10, 112, buttonWidth, 29);

    moveById(IdClipboardBridge, margin, 153, 330, 27);
    moveById(IdRequireApproval, 358, 153, 310, 27);

    moveById(IdCopyPrompt, margin, 188, 145, 31);
    moveById(IdRunClipboard, margin + 154, 188, 205, 31);
    moveById(IdClearOutput, margin + 368, 188, 115, 31);

    moveStaticByText(L"1. Paste this prompt into the browser chat", 0, margin, 233, 430, 25);
    moveById(IdPrompt, margin, 258, right - margin, 188);

    const int resultTitleY = 459;
    moveStaticByText(L"2. Terminal result", 0, margin, resultTitleY, 170, 25);
    MoveWindow(statusText_, margin + 175, resultTitleY, std::max(100, right - (margin + 175) - 145), 25, TRUE);
    moveById(IdCopyResult, right - 135, resultTitleY - 2, 135, 29);
    moveById(IdOutput, margin, resultTitleY + 29, right - margin, std::max(130, height - (resultTitleY + 47) - margin));
}

void App::handleCommand(WORD controlId, WORD notificationCode) {
    if (notificationCode != BN_CLICKED && notificationCode != EN_KILLFOCUS) {
        return;
    }

    switch (controlId) {
    case IdBrowseWorkspace:
        browseWorkspace();
        break;
    case IdOpenChat:
        openChat();
        break;
    case IdClipboardBridge:
        syncSettingsFromControls();
        updateBridgeStatus();
        break;
    case IdCopyPrompt:
        refreshPrompt();
        copyTextToClipboard(windowText(promptEdit_));
        setStatus(L"Agent prompt copied. Paste it into the browser chat.");
        break;
    case IdRunClipboard:
        captureClipboardCommand(true);
        break;
    case IdCopyResult:
        if (lastResult_.empty()) {
            setStatus(L"There is no terminal result to copy yet.", true);
        } else {
            copyTextToClipboard(lastResult_);
            setStatus(L"Last terminal result copied. Paste it into the browser chat.");
        }
        break;
    case IdClearOutput:
        setOutput(L"");
        setStatus(L"Log cleared.");
        break;
    case IdWorkspace:
        if (notificationCode == EN_KILLFOCUS) {
            refreshPrompt();
        }
        break;
    default:
        break;
    }
}

void App::captureClipboardCommand(bool initiatedManually) {
    if (executing_) {
        if (initiatedManually) {
            setStatus(L"A command is already running.", true);
        }
        return;
    }

    const std::wstring text = clipboardText();
    if (text.empty()) {
        if (initiatedManually) {
            setStatus(L"Clipboard has no text to run.", true);
        }
        return;
    }
    if (!ignoredClipboardText_.empty() && text == ignoredClipboardText_) {
        ignoredClipboardText_.clear();
        return;
    }

    ProtocolResult parsed = parseCommand(text);
    if (!parsed.ok) {
        if (initiatedManually) {
            setStatus(parsed.error, true);
        }
        return;
    }
    acceptCommand(std::move(parsed.command), initiatedManually);
}

void App::acceptCommand(CommandSpec command, bool initiatedManually) {
    const std::wstring workspace = windowText(workspaceEdit_);
    std::wstring workingDirectory;
    std::wstring error;
    if (!resolveWorkingDirectory(workspace, command.cwd, workingDirectory, error)) {
        setStatus(error, true);
        return;
    }

    const bool askApproval = IsDlgButtonChecked(window_, IdRequireApproval) == BST_CHECKED;
    if (askApproval) {
        std::wostringstream confirmation;
        confirmation << L"A browser chat requested a local terminal command.\n\n"
                     << L"ID: " << command.id << L"\n"
                     << L"Folder: " << workingDirectory << L"\n"
                     << L"Timeout: " << command.timeoutSeconds << L" seconds\n\n"
                     << L"Command:\n" << previewForDialog(command.command) << L"\n\n"
                     << L"It will run as your current Windows user. Only continue if you trust this request.";
        const int answer = MessageBoxW(
            window_, confirmation.str().c_str(), L"Approve terminal command?", MB_ICONWARNING | MB_YESNO | MB_DEFBUTTON2);
        if (answer != IDYES) {
            setStatus(L"Command was not approved.");
            return;
        }
    }

    appendOutput(
        L"\r\n> Received " + command.id + (initiatedManually ? L" (manual clipboard run)" : L" (clipboard bridge)") +
        L"\r\n> cwd: " + workingDirectory + L"\r\n> " + command.command + L"\r\n");
    executeAsync(std::move(command), workingDirectory);
}

void App::executeAsync(CommandSpec command, const std::wstring& resolvedWorkingDirectory) {
    setExecuting(true);
    setStatus(L"Running " + command.id + L"…");
    const HWND target = window_;
    std::thread([target, command = std::move(command), resolvedWorkingDirectory] () mutable {
        auto completion = std::make_unique<ExecutionCompletion>();
        completion->command = command;
        completion->result = runCommand(command, resolvedWorkingDirectory);
        if (!PostMessageW(target, App::kExecuteCompletedMessage, 0, reinterpret_cast<LPARAM>(completion.get()))) {
            return;
        }
        completion.release();
    }).detach();
}

void App::completeExecution(std::unique_ptr<ExecutionCompletion> completion) {
    setExecuting(false);
    const ExecutionResult& execution = completion->result;
    std::wstring terminalOutput = execution.output;
    if (!execution.launchError.empty()) {
        if (!terminalOutput.empty()) {
            terminalOutput += L"\n";
        }
        terminalOutput += L"[RelayBridge error] " + execution.launchError;
    }
    if (terminalOutput.empty()) {
        terminalOutput = L"[Command completed without output.]";
    }

    const bool wasTruncated = execution.outputWasTruncated || terminalOutput.size() > 60'000;
    lastResult_ = formatResult(
        completion->command.id,
        execution.exitCode,
        execution.timedOut,
        terminalOutput,
        wasTruncated);
    appendOutput(L"\r\n" + lastResult_ + L"\r\n");
    copyTextToClipboard(lastResult_);

    if (!execution.launchError.empty()) {
        setStatus(L"RelayBridge could not start or monitor " + completion->command.id + L". Details were copied to the clipboard.", true);
    } else if (execution.timedOut) {
        setStatus(L"Timed out. The terminal result was copied to the clipboard.", true);
    } else {
        setStatus(L"Completed (exit " + std::to_wstring(execution.exitCode) + L"). Result copied — paste it into the chat.");
    }
}

void App::browseWorkspace() {
    BROWSEINFOW browse{};
    browse.hwndOwner = window_;
    browse.lpszTitle = L"Choose the root folder RelayBridge may use as cwd";
    browse.ulFlags = BIF_RETURNONLYFSDIRS | BIF_USENEWUI;

    PIDLIST_ABSOLUTE selected = SHBrowseForFolderW(&browse);
    if (selected == nullptr) {
        return;
    }
    wchar_t selectedPath[MAX_PATH]{};
    if (SHGetPathFromIDListW(selected, selectedPath)) {
        SetWindowTextW(workspaceEdit_, selectedPath);
        refreshPrompt();
        setStatus(L"Workspace changed. The agent prompt was refreshed.");
    }
    CoTaskMemFree(selected);
}

void App::openChat() {
    const std::wstring url = windowText(chatUrlEdit_);
    if (url.empty() || (url.rfind(L"https://", 0) != 0 && url.rfind(L"http://", 0) != 0)) {
        setStatus(L"Enter a full http:// or https:// chat URL first.", true);
        return;
    }
    const auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(window_, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
    if (result <= 32) {
        setStatus(L"Windows could not open that chat URL.", true);
    } else {
        setStatus(L"Chat opened in your default browser.");
    }
}

void App::refreshPrompt() {
    if (promptEdit_ != nullptr) {
        SetWindowTextW(promptEdit_, makeAgentPrompt(windowText(workspaceEdit_)).c_str());
    }
}

void App::syncSettingsFromControls() {
    if (workspaceEdit_ == nullptr) {
        return;
    }
    settings_.workspace = windowText(workspaceEdit_);
    settings_.chatUrl = windowText(chatUrlEdit_);
    settings_.clipboardBridgeEnabled = IsDlgButtonChecked(window_, IdClipboardBridge) == BST_CHECKED;
    settings_.requireApproval = IsDlgButtonChecked(window_, IdRequireApproval) == BST_CHECKED;
}

void App::updateBridgeStatus() {
    const bool enabled = IsDlgButtonChecked(window_, IdClipboardBridge) == BST_CHECKED;
    setStatus(enabled
        ? L"Clipboard bridge is ON. Copy a relay-command response from the chat to receive it here."
        : L"Clipboard bridge is OFF. Use “Run command from clipboard” when you are ready.");
}

void App::setStatus(const std::wstring& text, bool isProblem) {
    if (statusText_ != nullptr) {
        std::wstring display = isProblem ? L"Warning: " : L"";
        display += text;
        SetWindowTextW(statusText_, display.c_str());
    }
}

void App::appendOutput(const std::wstring& text) {
    if (outputEdit_ == nullptr) {
        return;
    }
    const int length = GetWindowTextLengthW(outputEdit_);
    SendMessageW(outputEdit_, EM_SETSEL, length, length);
    SendMessageW(outputEdit_, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(text.c_str()));
    SendMessageW(outputEdit_, EM_SCROLLCARET, 0, 0);
}

void App::setOutput(const std::wstring& text) {
    SetWindowTextW(outputEdit_, text.c_str());
}

void App::setExecuting(bool executing) {
    executing_ = executing;
    EnableWindow(runClipboardButton_, !executing);
    EnableWindow(copyResultButton_, !executing);
}

void App::copyTextToClipboard(const std::wstring& text) {
    if (!OpenClipboard(window_)) {
        setStatus(L"Windows clipboard is busy; use Copy last result once it is available.", true);
        return;
    }
    EmptyClipboard();
    const std::size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (memory == nullptr) {
        CloseClipboard();
        setStatus(L"RelayBridge could not allocate clipboard memory.", true);
        return;
    }

    void* destination = GlobalLock(memory);
    if (destination == nullptr) {
        GlobalFree(memory);
        CloseClipboard();
        setStatus(L"RelayBridge could not write to the clipboard.", true);
        return;
    }
    memcpy(destination, text.c_str(), bytes);
    GlobalUnlock(memory);
    if (SetClipboardData(CF_UNICODETEXT, memory) == nullptr) {
        GlobalFree(memory);
        CloseClipboard();
        setStatus(L"RelayBridge could not publish text to the clipboard.", true);
        return;
    }
    ignoredClipboardText_ = text;
    CloseClipboard();
}

std::wstring App::clipboardText() const {
    if (!OpenClipboard(window_)) {
        return {};
    }
    HANDLE data = GetClipboardData(CF_UNICODETEXT);
    if (data == nullptr) {
        CloseClipboard();
        return {};
    }
    const wchar_t* source = static_cast<const wchar_t*>(GlobalLock(data));
    std::wstring text = source == nullptr ? L"" : source;
    if (source != nullptr) {
        GlobalUnlock(data);
    }
    CloseClipboard();
    return text;
}

std::wstring App::windowText(HWND control) const {
    const int length = GetWindowTextLengthW(control);
    if (length <= 0) {
        return {};
    }
    std::wstring text(static_cast<std::size_t>(length) + 1, L'\0');
    GetWindowTextW(control, text.data(), length + 1);
    text.resize(static_cast<std::size_t>(length));
    return text;
}

} // namespace relay
