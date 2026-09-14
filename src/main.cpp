#include "App.h"

#include <windows.h>

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    relay::App app(instance);
    return app.run(showCommand);
}
