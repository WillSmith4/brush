# SPDX-License-Identifier: GPL-3.0-or-later
# Added as the last subdirectory of the pinned LibrePaint source tree.
add_library(FeatherKritaEngine SHARED KritaBridge.cpp)
target_compile_features(FeatherKritaEngine PRIVATE cxx_std_17)
set_target_properties(FeatherKritaEngine PROPERTIES
    PREFIX "" OUTPUT_NAME "FeatherKritaEngine"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES
    MACOSX_RPATH NO INSTALL_NAME_DIR "@rpath"
    QT_DEFAULT_PLUGINS 0)
target_link_libraries(FeatherKritaEngine PRIVATE
    kritaresources kritalibbrush kritaimage kritapainting kritapigment kritaplugin
    Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Xml Qt6::Sql Qt6::Svg
    Qt6::QMinimalIntegrationPlugin Qt6::QMinimalIntegrationPlugin_init
    Qt6::QSQLiteDriverPlugin Qt6::QSQLiteDriverPlugin_init
    Qt6::QSvgPlugin Qt6::QSvgPlugin_init)

# Import paint operators, color engines, and filters without the application UI.
get_property(_all_plugins GLOBAL PROPERTY KRITA_IOS_STATIC_PLUGIN_TARGETS)
file(READ "${CMAKE_SOURCE_DIR}/packaging/ios/manifests/plugins.json" _manifest)
string(JSON _plugin_count LENGTH "${_manifest}" plugins)
math(EXPR _last_plugin "${_plugin_count}-1")
set(_selected_plugins)
foreach(_i RANGE 0 ${_last_plugin})
    string(JSON _category GET "${_manifest}" plugins ${_i} category)
    string(JSON _target GET "${_manifest}" plugins ${_i} target)
    if(_category MATCHES "^(paintops|color|filters)$" AND TARGET ${_target})
        list(APPEND _selected_plugins ${_target})
    endif()
endforeach()
if(NOT "kritadefaultpaintops" IN_LIST _selected_plugins)
    message(FATAL_ERROR "Native pixel brush plugin was not selected")
endif()
set_property(GLOBAL PROPERTY KRITA_IOS_STATIC_PLUGIN_TARGETS ${_selected_plugins})
krita_ios_target_static_plugins(FeatherKritaEngine)
set_property(GLOBAL PROPERTY KRITA_IOS_STATIC_PLUGIN_TARGETS ${_all_plugins})
krita_ios_target_static_resources(FeatherKritaEngine)
qt_add_resources(_resources
    "${CMAKE_SOURCE_DIR}/plugins/paintops/defaultpresets/defaultpresets.qrc"
    "${CMAKE_SOURCE_DIR}/krita/data/mime-database/mime-database.qrc")
target_sources(FeatherKritaEngine PRIVATE ${_resources})
target_link_options(FeatherKritaEngine PRIVATE "-Wl,-no_adhoc_codesign")
