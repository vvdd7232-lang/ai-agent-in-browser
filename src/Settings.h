#pragma once

#include <string>

namespace relay {

struct Settings {
    std::wstring workspace;
    std::wstring chatUrl = L"https://chatgpt.com/";
    bool clipboardBridgeEnabled = false;
    bool requireApproval = true;
};

class SettingsStore {
public:
    SettingsStore();

    Settings load() const;
    void save(const Settings& settings) const;

private:
    std::wstring iniPath_;
};

} // namespace relay
