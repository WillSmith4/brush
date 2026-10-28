// SPDX-License-Identifier: GPL-3.0-or-later
// Paint execution follows LibrePaint's FreehandStrokeContractTest contract.
#include "KritaBridge.h"
#include <QApplication>
#include <QBuffer>
#include <QCryptographicHash>
#include <QDir>
#include <QDomDocument>
#include <QFileInfo>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QThread>
#include <QPluginLoader>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

#include <KoColor.h>
#include <KoColorSpaceRegistry.h>
#include <KoPattern.h>
#include <KoResourcePaths.h>
#include <KoSegmentGradient.h>
#include <KoStopGradient.h>
#include <KisGlobalResourcesInterface.h>
#include <KisMimeDatabase.h>
#include <KisResourceCacheDb.h>
#include <KisResourceLoader.h>
#include <KisResourceLoaderRegistry.h>
#include <KisResourceLocator.h>
#include <KisResourceStorage.h>
#include <KisResourceTypes.h>
#include <kis_brush_registry.h>
#include <kis_brush.h>
#include <brushengine/kis_paint_information.h>
#include <brushengine/kis_paintop_preset.h>
#include <brushengine/kis_paintop_registry.h>
#include <brushengine/kis_paintop_settings.h>
#include <kis_group_layer.h>
#include <kis_image.h>
#include <kis_paint_layer.h>
#include <kis_resources_snapshot.h>
#include <kis_undo_stores.h>
#include <strokes/KisFreehandStrokeInfo.h>
#include <strokes/freehand_stroke.h>
#include <KisAsynchronousStrokeUpdateHelper.h>

Q_IMPORT_PLUGIN(QMinimalIntegrationPlugin)

namespace {
QApplication *application = nullptr;
QMap<QString, KisPaintOpPresetSP> presets;
QString storageRoot;
bool initialized = false;

void require(bool condition, const QString &message) {
    if (!condition) throw std::runtime_error(message.toStdString());
}

QJsonObject initialize(const QJsonObject &request) {
    if (initialized) return {{"ready", true}};
    require(!QCoreApplication::instance(), "A different Qt application already exists in this process.");
    storageRoot = request["storageRoot"].toString();
    const QString resources = request["resources"].toString();
    require(QDir::isAbsolutePath(storageRoot) && QDir::isAbsolutePath(resources), "Resource paths must be absolute.");
    require(QDir().mkpath(storageRoot), "Cannot create the brush resource folder.");
    static int argc = 3;
    static char name[] = "FeatherKrita";
    static char platformFlag[] = "-platform";
    static char platform[] = "minimal";
    static char *argv[] = {name, platformFlag, platform, nullptr};
    application = new QApplication(argc, argv);
    application->setQuitOnLastWindowClosed(false);
    QCoreApplication::setApplicationName("FeatherKrita");
    QCoreApplication::setOrganizationName("FeatherKrita");
    KoResourcePaths::s_overrideAppDataLocation = storageRoot;
    KoResourcePaths::addAssetDir("icc_profiles", resources + "/profiles", true);
    auto *loaders = KisResourceLoaderRegistry::instance();
    KisPaintOpRegistry::registerResourceLoader(*loaders);
    KisBrushRegistry::registerResourceLoaders(*loaders);
    KisBrushRegistry::registerResourceCacheFixup(*loaders);
    loaders->add(new KisResourceLoader<KoPattern>(ResourceType::Patterns, ResourceType::Patterns,
        "Patterns", {"application/x-gimp-pattern", "image/x-gimp-pat", "image/png", "image/jpeg", "image/tiff"}));
    loaders->add(new KisResourceLoader<KoSegmentGradient>(ResourceSubType::SegmentedGradients,
        ResourceType::Gradients, "Gradients", {"application/x-gimp-gradient"}));
    loaders->add(new KisResourceLoader<KoStopGradient>(ResourceSubType::StopGradients,
        ResourceType::Gradients, "Gradients", {"image/svg+xml"}));
    require(KisResourceCacheDb::initialize(storageRoot), "Cannot initialize the brush resource database.");
    auto *locator = KisResourceLocator::instance();
    require(locator->initialize(resources) == KisResourceLocator::LocatorError::Ok,
        locator->errorMessages().join("\n"));
    auto *registry = KisPaintOpRegistry::instance();
    require(registry->contains("paintbrush"), "The native Pixel Brush engine was not registered.");
    QJsonArray engines;
    for (const auto &id : registry->keys()) engines.append(id);
    initialized = true;
    return {{"ready", true}, {"engines", engines}};
}

void appendPreset(QJsonArray &result, KoResourceSP resource, const QString &identity) {
    auto preset = resource.dynamicCast<KisPaintOpPreset>();
    if (!preset || !preset->valid() || !preset->settings()) return;
    const QString engine = preset->paintOp().id();
    if (!KisPaintOpRegistry::instance()->contains(engine)) return;
    Q_UNUSED(identity);
    const QByteArray identityBytes = preset->md5Sum().toUtf8() + engine.toUtf8() + preset->filename().toUtf8();
    const QString id = QString::fromLatin1(QCryptographicHash::hash(identityBytes, QCryptographicHash::Sha256).toHex());
    presets[id] = preset;
    result.append(QJsonObject{{"id", id}, {"name", preset->name()}, {"engine", engine}});
}

void appendBrushTip(QJsonArray &result, KoResourceSP resource, const QString &identity) {
    auto brush = resource.dynamicCast<KisBrush>();
    if (!brush || !brush->valid()) return;
    auto preset = KisPaintOpRegistry::instance()->defaultPreset(KoID("paintbrush"), KisGlobalResourcesInterface::instance());
    if (!preset || !preset->settings()) return;
    QDomDocument definition("Brush");
    QDomElement element = definition.createElement("Brush");
    definition.appendChild(element);
    brush->toXML(definition, element);
    preset->settings()->setProperty("brush_definition", definition.toString());
    preset->settings()->setProperty("PressureSize", true);
    preset->setName(brush->name());
    preset->setFilename(brush->filename() + ".kpp");
    preset->setValid(true);
    appendPreset(result, preset, identity);
}

QJsonObject importPresets(const QJsonObject &request) {
    const QString path = QFileInfo(request["path"].toString()).canonicalFilePath();
    require(!path.isEmpty() && QFileInfo(path).isFile(), "The selected file cannot be read.");
    QJsonArray result;
    KisResourceStorageSP storage(new KisResourceStorage(path));
    if (storage->valid() && (storage->type() == KisResourceStorage::StorageType::Bundle ||
        storage->type() == KisResourceStorage::StorageType::AdobeBrushLibrary)) {
        require(KisResourceLocator::instance()->addStorage(path, storage), "Krita could not register this resource bundle.");
        auto iterator = storage->resources(ResourceType::PaintOpPresets);
        while (iterator && iterator->hasNext()) {
            iterator->next();
            appendPreset(result, iterator->resource(), path + ':' + iterator->url());
        }
        if (result.isEmpty()) {
            auto tips = storage->resources(ResourceType::Brushes);
            while (tips && tips->hasNext()) {
                tips->next();
                appendBrushTip(result, tips->resource(), path + ':' + tips->url());
            }
        }
    } else {
        auto *registry = KisResourceLoaderRegistry::instance();
        const QString mime = KisMimeDatabase::mimeTypeForFile(path);
        if (registry->loader(ResourceType::PaintOpPresets, mime)) {
            appendPreset(result, KisResourceLocator::instance()->importResourceFromFile(ResourceType::PaintOpPresets, path, false), path);
        } else if (registry->loader(ResourceType::Brushes, mime)) {
            appendBrushTip(result, KisResourceLocator::instance()->importResourceFromFile(ResourceType::Brushes, path, false), path);
        }
    }
    require(!result.isEmpty(), "Krita found no supported brush presets or brush tips in this file.");
    return {{"presets", result}};
}

KisPaintInformation point(const QJsonArray &v) {
    require(v.size() >= 3, "A stroke point must include x, y and pressure.");
    const double x = v[0].toDouble(NAN), y = v[1].toDouble(NAN), pressure = v[2].toDouble(NAN);
    require(std::isfinite(x) && std::isfinite(y) && std::isfinite(pressure), "Non-finite stroke input.");
    KisPaintInformation p(QPointF(x, y), std::clamp(pressure, 0.0, 1.0),
        0.0, 0.0, 0.0, 0.0, 1.0, v.size() > 3 ? v[3].toDouble() : 0.0, 0.0);
    p.setCanvasRotation(0.0); p.setCanvasMirroredH(false); p.setCanvasMirroredV(false);
    p.setTiltDirectionOffset(0.0); p.setLevelOfDetail(0);
    return p;
}

QJsonObject render(const QJsonObject &request) {
    const QString id = request["preset"].toString();
    require(presets.contains(id), "The selected brush preset is no longer loaded.");
    const int width = request["width"].toInt(), height = request["height"].toInt();
    const QJsonArray points = request["points"].toArray(), color = request["color"].toArray();
    require(width > 0 && width <= 4096 && height > 0 && height <= 1024 &&
        qint64(width) * height <= 2097152, "The requested stroke texture is too large.");
    require(!points.isEmpty() && points.size() <= 10000 && color.size() >= 3, "Invalid stroke input.");
    const double size = request["size"].toDouble();
    require(std::isfinite(size) && size > 0 && size <= 2048, "Invalid brush size.");
    auto preset = presets[id]->clone().dynamicCast<KisPaintOpPreset>();
    require(bool(preset), "Cannot clone the selected brush preset.");
    preset->settings()->setPaintOpSize(size);
    const auto *space = KoColorSpaceRegistry::instance()->rgb8();
    KisImageSP image = new KisImage(new KisDumbUndoStore(), width, height, space, "Stroke texture");
    image->setWorkingThreadsLimit(1);
    KisPaintLayerSP layer = new KisPaintLayer(image, "Brush", OPACITY_OPAQUE_U8);
    image->addNode(layer, image->rootLayer());
    image->initialRefreshGraph(); image->waitForDone();
    KisResourcesSnapshotSP resources = new KisResourcesSnapshot(image, layer);
    resources->setBrush(preset);
    const QColor foreground(std::clamp(color[0].toInt(), 0, 255), std::clamp(color[1].toInt(), 0, 255), std::clamp(color[2].toInt(), 0, 255));
    resources->setFGColorOverride(KoColor(foreground, space));
    resources->setBGColorOverride(KoColor(Qt::white, space));
    resources->setOpacity(std::clamp(request["opacity"].toDouble(1.0), 0.0, 1.0));
    resources->setMirroring(false, false);
    QVector<KisPaintInformation> validatedPoints;
    validatedPoints.reserve(points.size());
    for (const auto &value : points) validatedPoints.append(point(value.toArray()));
    auto *strategy = new FreehandStrokeStrategy(resources, new KisFreehandStrokeInfo(),
        kundo2_noi18n("Brush texture"), FreehandStrokeStrategy::None, request["seed"].toInt(1));
    const KisStrokeId stroke = image->startStroke(strategy);
    auto previous = validatedPoints[0];
    if (validatedPoints.size() == 1) image->addJob(stroke, new FreehandStrokeStrategy::Data(0, previous));
    for (int i = 1; i < validatedPoints.size(); ++i) {
        auto next = validatedPoints[i];
        image->addJob(stroke, new FreehandStrokeStrategy::Data(0, previous, next));
        previous = next;
    }
    image->addJob(stroke, new KisAsynchronousStrokeUpdateHelper::UpdateData(true));
    image->endStroke(stroke); image->waitForDone();
    const QImage output = layer->paintDevice()->convertToQImage(nullptr, 0, 0, width, height);
    QByteArray png; QBuffer buffer(&png); buffer.open(QIODevice::WriteOnly);
    require(output.save(&buffer, "PNG"), "Cannot encode the native brush output.");
    return {{"width", width}, {"height", height}, {"png", QString::fromLatin1(png.toBase64())}};
}
}

extern "C" char *FKRequest(const char *json) {
    QJsonObject response;
    try {
        require(json, "Missing request.");
        QJsonParseError error;
        const auto document = QJsonDocument::fromJson(QByteArray(json), &error);
        require(error.error == QJsonParseError::NoError && document.isObject(), "Malformed brush request.");
        const QJsonObject request = document.object();
        const QString command = request["command"].toString();
        if (command == "initialize") response = initialize(request);
        else {
            require(initialized && QThread::currentThread() == application->thread(), "The brush runtime is not ready on this thread.");
            if (command == "import") response = importPresets(request);
            else if (command == "render") response = render(request);
            else throw std::runtime_error("Unknown brush command.");
        }
        response["ok"] = true;
    } catch (const std::exception &e) {
        response = {{"ok", false}, {"error", QString::fromUtf8(e.what())}};
    } catch (...) {
        response = {{"ok", false}, {"error", "The native brush engine failed."}};
    }
    const QByteArray bytes = QJsonDocument(response).toJson(QJsonDocument::Compact);
    char *result = static_cast<char *>(std::malloc(bytes.size() + 1));
    if (result) std::memcpy(result, bytes.constData(), bytes.size() + 1);
    return result;
}
extern "C" void FKFreeResponse(char *response) { std::free(response); }
