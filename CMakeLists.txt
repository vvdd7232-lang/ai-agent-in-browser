cmake_minimum_required(VERSION 3.21)

project(RelayBridge VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(RELAY_BUILD_TESTS "Build the protocol parser tests" ON)

add_library(relay_protocol STATIC
    src/BridgeProtocol.cpp
)
target_include_directories(relay_protocol PUBLIC src)
target_compile_features(relay_protocol PUBLIC cxx_std_20)

if(MSVC)
    target_compile_options(relay_protocol PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(relay_protocol PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(WIN32)
    add_executable(RelayBridge WIN32
        src/main.cpp
        src/App.cpp
        src/CommandRunner.cpp
        src/Settings.cpp
        resources/RelayBridge.rc
    )

    target_link_libraries(RelayBridge PRIVATE
        relay_protocol
        user32
        gdi32
        shell32
        ole32
        comctl32
    )
    target_include_directories(RelayBridge PRIVATE src)

    if(MSVC)
        # A release build is a single convenient .exe: do not require a separate VC runtime installer.
        set_property(TARGET RelayBridge PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
        target_compile_options(RelayBridge PRIVATE /W4 /permissive- /utf-8)
        target_link_options(RelayBridge PRIVATE /MANIFESTUAC:"level='asInvoker' uiAccess='false'")
    endif()

    set_target_properties(RelayBridge PROPERTIES
        OUTPUT_NAME "RelayBridge"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    )
else()
    message(STATUS "RelayBridge.exe is a native Windows application; only portable protocol tests are available on this platform.")
endif()

if(RELAY_BUILD_TESTS)
    enable_testing()
    add_executable(relay_protocol_tests tests/protocol_tests.cpp)
    target_link_libraries(relay_protocol_tests PRIVATE relay_protocol)
    if(MSVC)
        target_compile_options(relay_protocol_tests PRIVATE /W4 /permissive- /utf-8)
    else()
        target_compile_options(relay_protocol_tests PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME relay_protocol_tests COMMAND relay_protocol_tests)
endif()
