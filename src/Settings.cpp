#include "Settings.h"

#include <windows.h>
#include <shlobj.h>

#include <iterator>

namespace relay {
namespace {

bool getBool(const std::wstring& value, bool fallback) {
    if (value == L"1" || value == L"true") {
        return true;
    }
    if (value == L"0" || value == L"false") {
        return false;
    }
    return fallback;
}

} // namespace

SettingsStore::SettingsStore() {
    wchar_t appData[MAX_PATH]{};
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_APPDATA | CSIDL_FLAG_CREATE, nullptr, SHGFP_TYPE_CURRENT, appData))) {
        std::wstring directory = std::wstring(appData) + L"\\RelayBridge";
        CreateDirectoryW(directory.c_str(), nullptr);
        iniPath_ = directory + L"\\settings.ini";
    } else {
        iniPath_ = L"RelayBridge-settings.ini";
    }
}

Settings SettingsStore::load() const {
    Settings settings;

    wchar_t buffer[4096]{};
    const DWORD workspaceLength = GetPrivateProfileStringW(
        L"RelayBridge", L"workspace", L"", buffer, static_cast<DWORD>(std::size(buffer)), iniPath_.c_str());
    settings.workspace.assign(buffer, workspaceLength);

    const DWORD urlLength = GetPrivateProfileStringW(
        L"RelayBridge", L"chat_url", settings.chatUrl.c_str(), buffer, static_cast<DWORD>(std::size(buffer)), iniPath_.c_str());
    settings.chatUrl.assign(buffer, urlLength);

    GetPrivateProfileStringW(L"RelayBridge", L"clipboard_enabled", L"0", buffer, static_cast<DWORD>(std::size(buffer)), iniPath_.c_str());
    settings.clipboardBridgeEnabled = getBool(buffer, false);

    GetPrivateProfileStringW(L"RelayBridge", L"require_approval", L"1", buffer, static_cast<DWORD>(std::size(buffer)), iniPath_.c_str());
    settings.requireApproval = getBool(buffer, true);
    return settings;
}

void SettingsStore::save(const Settings& settings) const {
    WritePrivateProfileStringW(L"RelayBridge", L"workspace", settings.workspace.c_str(), iniPath_.c_str());
    WritePrivateProfileStringW(L"RelayBridge", L"chat_url", settings.chatUrl.c_str(), iniPath_.c_str());
    WritePrivateProfileStringW(L"RelayBridge", L"clipboard_enabled", settings.clipboardBridgeEnabled ? L"1" : L"0", iniPath_.c_str());
    WritePrivateProfileStringW(L"RelayBridge", L"require_approval", settings.requireApproval ? L"1" : L"0", iniPath_.c_str());
}

} // namespace relay
