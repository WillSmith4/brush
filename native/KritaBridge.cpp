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
#include <QImageReader>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QThread>
#include <QPluginLoader>
#include <dispatch/dispatch.h>
#include <memory>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <mutex>
#include <condition_variable>
#include <vector>
#include <KisRunnableStrokeJobData.h>
#include <kis_painter.h>

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
#include <KisResourceModel.h>
#include <KisResourceStorage.h>
#include <KisResourceTypes.h>
#include <kis_brush_registry.h>
#include <kis_brush.h>
#include <brushengine/kis_paint_information.h>
#include <brushengine/kis_paintop_preset.h>
#include <brushengine/kis_paintop_registry.h>
#include <brushengine/kis_paintop_settings.h>
#include <brushengine/KisOptimizedBrushOutline.h>
#include <kis_paint_device.h>
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
            KisResourceModel model(ResourceType::PaintOpPresets);
            appendPreset(result, model.importResourceFile(path, true), path);
        } else if (registry->loader(ResourceType::Brushes, mime)) {
            KisResourceModel model(ResourceType::Brushes);
            appendBrushTip(result, model.importResourceFile(path, true), path);
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

QJsonObject presetInfo(const QJsonObject &request) {
    const QString id = request["preset"].toString();
    require(presets.contains(id), "The selected brush preset is no longer loaded.");
    auto preset = presets[id]->clone().dynamicCast<KisPaintOpPreset>();
    preset->settings()->setPaintOpSize(128.0);
    KisPaintOpSettings::OutlineMode mode;
    mode.isVisible = true;
    mode.forceFullSize = true;
    const auto outline = preset->settings()->brushOutline(point(QJsonArray{0, 0, 1}), mode, 1.0);
    const QRectF bounds = outline.boundingRect();
    QJsonArray polygons;
    for (const auto &polygon : outline) {
        QJsonArray vertices;
        for (const auto &p : polygon) vertices.append(QJsonArray{p.x() / 128.0, p.y() / 128.0});
        polygons.append(vertices);
    }
    const QString engine = preset->paintOp().id();
    return {{"engine", engine}, {"outline", polygons},
        {"extent", std::max({1.0, std::abs(bounds.left()) / 64.0,
            std::abs(bounds.right()) / 64.0, std::abs(bounds.top()) / 64.0,
            std::abs(bounds.bottom()) / 64.0})},
        {"samplesBackdrop", engine == "colorsmudge" || engine == "filter"},
        {"previewSessions", true}};
}

QString encodePng(const QImage &image) {
    QByteArray png;
    QBuffer buffer(&png);
    buffer.open(QIODevice::WriteOnly);
    require(image.save(&buffer, "PNG"), "Cannot encode the native brush output.");
    return QString::fromLatin1(png.toBase64());
}

struct RenderJob {
    KisImageSP image;
    KisPaintLayerSP layer;
    QImage backdrop;
    int width = 0, height = 0;
    KisResourcesSnapshotSP resources;
    QJsonArray points;
    QJsonObject settings;
    KisStrokeId stroke;
    bool started = false, ended = false;
    int submitted = 0;
};

// Only the UI thread accesses the session table. All rendering/closing work is
// serialized on the engine queue; the WebKit thread never enqueues thousands of
// paint jobs or waits for the image scheduler to finish.
QMap<QString, std::shared_ptr<RenderJob>> previewSessions;
bool renderBusy = false;
dispatch_queue_t renderQueue() {
    static dispatch_queue_t queue = dispatch_queue_create("FeatherKrita.native-render", DISPATCH_QUEUE_SERIAL);
    return queue;
}

void matchCursorSize(KisPaintOpPresetSP preset, double size) {
    // The cursor deliberately ignores the preset's static Size sensor value.
    // Normalize that value at full pressure; retain pressure dynamics around it.
    preset->settings()->setPaintOpSize(128.0);
    KisPaintOpSettings::OutlineMode mode;
    mode.isVisible = true; mode.forceFullSize = true;
    const auto info = point(QJsonArray{0, 0, 1});
    const QRectF full = preset->settings()->brushOutline(info, mode, 1.0).boundingRect();
    mode.forceFullSize = false;
    const QRectF actual = preset->settings()->brushOutline(info, mode, 1.0).boundingRect();
    const double expected = std::max(full.width(), full.height());
    const double measured = std::max(actual.width(), actual.height());
    const double correction = measured > 0.01 && expected > 0.01 ? std::clamp(expected / measured, 0.05, 20.0) : 1.0;
    preset->settings()->setPaintOpSize(size * correction);
}

std::shared_ptr<RenderJob> prepareRender(const QJsonObject &request) {
    const QString id = request["preset"].toString();
    require(presets.contains(id), "The selected brush preset is no longer loaded.");
    const int width = request["width"].toInt(), height = request["height"].toInt();
    const QJsonArray points = request["points"].toArray(), color = request["color"].toArray();
    require(width > 0 && width <= 4096 && height > 0 && height <= 4096 &&
        qint64(width) * height <= 2097152, "The requested stroke texture is too large.");
    require(!points.isEmpty() && points.size() <= 10000 && color.size() >= 3, "Invalid stroke input.");
    const double size = request["size"].toDouble();
    require(std::isfinite(size) && size > 0 && size <= 2048, "Invalid brush size.");
    auto preset = presets[id]->clone().dynamicCast<KisPaintOpPreset>();
    require(bool(preset), "Cannot clone the selected brush preset.");
    matchCursorSize(preset, size);
    const auto *space = KoColorSpaceRegistry::instance()->rgb8();
    KisImageSP image = new KisImage(new KisDumbUndoStore(), width, height, space, "Stroke texture");
    image->setWorkingThreadsLimit(1);
    KisPaintLayerSP layer = new KisPaintLayer(image, "Brush", OPACITY_OPAQUE_U8);
    image->addNode(layer, image->rootLayer());
    // Smudge reads the actual visible host artwork, including native Feather
    // strokes. Seed the working layer itself, so both smudge overlay modes work.
    QImage backdrop;
    if (request.contains("backdrop")) {
        const QString encoded = request["backdrop"].toString();
        require(encoded.size() <= 16777216, "The brush backdrop is too large.");
        QByteArray bytes = QByteArray::fromBase64(encoded.toLatin1());
        QBuffer source(&bytes); source.open(QIODevice::ReadOnly);
        QImageReader reader(&source, "PNG");
        require(reader.size() == QSize(width, height), "The brush backdrop dimensions do not match.");
        backdrop = reader.read().convertToFormat(QImage::Format_ARGB32);
        require(!backdrop.isNull(), "Cannot decode the brush backdrop.");
        layer->paintDevice()->convertFromQImage(backdrop, nullptr);
    }
    // Compare in the engine's actual color space, after import/rounding, so
    // unrelated pixels never become part of the returned paint surface.
    if (!backdrop.isNull()) backdrop = layer->paintDevice()->convertToQImage(nullptr, 0, 0, width, height).convertToFormat(QImage::Format_ARGB32);
    KisResourcesSnapshotSP resources = new KisResourcesSnapshot(image, layer);
    resources->setBrush(preset);
    const QColor foreground(std::clamp(color[0].toInt(), 0, 255), std::clamp(color[1].toInt(), 0, 255), std::clamp(color[2].toInt(), 0, 255));
    resources->setFGColorOverride(KoColor(foreground, space));
    resources->setBGColorOverride(KoColor(Qt::white, space));
    resources->setOpacity(std::clamp(request["opacity"].toDouble(1.0), 0.0, 1.0));
    resources->setMirroring(false, false);
    auto job = std::make_shared<RenderJob>();
    job->image = image; job->layer = layer; job->backdrop = backdrop;
    job->width = width; job->height = height;
    job->resources = resources; job->points = points; job->settings = request;
    return job;
}

void submitPoints(RenderJob &job) {
    // Validate the entire addition before changing the live painter.
    QVector<KisPaintInformation> points;
    const int first = job.submitted ? job.submitted - 1 : 0;
    for (int i = first; i < job.points.size(); ++i) points.append(point(job.points[i].toArray()));
    if (!job.started) {
        job.image->initialRefreshGraph();
        auto *strategy = new FreehandStrokeStrategy(job.resources, new KisFreehandStrokeInfo(),
            kundo2_noi18n("Brush texture"), FreehandStrokeStrategy::None, job.settings["seed"].toInt(1));
        job.stroke = job.image->startStroke(strategy); job.started = true;
        if (job.points.size() == 1) job.image->addJob(job.stroke, new FreehandStrokeStrategy::Data(0, points[0]));
    }
    for (int i = 1; i < points.size(); ++i)
        job.image->addJob(job.stroke, new FreehandStrokeStrategy::Data(0, points[i - 1], points[i]));
    job.submitted = job.points.size();
    job.image->addJob(job.stroke, new KisAsynchronousStrokeUpdateHelper::UpdateData(true));
}

void closeRender(RenderJob &job) {
    if (job.started && !job.ended) {
        job.image->endStroke(job.stroke); job.ended = true;
        job.image->waitForDone();
    }
}

bool canAppend(const RenderJob &job, const QJsonObject &request) {
    // A changed projection, pressure, brush setting or sampled backdrop needs
    // a fresh replay. Never reuse incompatible paint just to make preview fast.
    if (job.ended || job.submitted < 2 || request["points"].toArray().size() < job.submitted) return false;
    for (const char *key : {"preset", "size", "color", "opacity", "seed", "backdrop", "width", "height"})
        if (job.settings[key] != request[key]) return false;
    const auto next = request["points"].toArray();
    for (int i = 0; i < job.submitted; ++i) if (next[i] != job.points[i]) return false;
    return true;
}

QImage captureLive(RenderJob &job) {
    // waitForDone() cannot be used with an open stroke. A barrier runs after the
    // paintop's inserted asynchronous/masking updates, while preserving its
    // spacing, random source and smudge state for the next appended points.
    std::mutex mutex; std::condition_variable ready; bool done = false;
    QImage output; std::exception_ptr failure;
    job.image->addJob(job.stroke, new KisRunnableStrokeJobData([&] {
        try {
            KisPaintDeviceSP copy = new KisPaintDevice(*job.layer->paintDevice());
            if (job.layer->hasTemporaryTarget()) {
                KisIndirectPaintingSupport::ReadLocker lock(job.layer.data());
                KisPainter painter(copy); job.layer->setupTemporaryPainter(&painter);
                painter.bitBlt(QPoint(0, 0), job.layer->temporaryTarget(), QRect(0, 0, job.width, job.height));
            }
            output = copy->convertToQImage(nullptr, 0, 0, job.width, job.height).convertToFormat(QImage::Format_ARGB32);
        } catch (...) { failure = std::current_exception(); }
        { std::lock_guard<std::mutex> lock(mutex); done = true; } ready.notify_one();
    }, KisStrokeJobData::BARRIER));
    std::unique_lock<std::mutex> lock(mutex); ready.wait(lock, [&] { return done; });
    if (failure) std::rethrow_exception(failure);
    return output;
}

QJsonObject finishRender(RenderJob &job, bool live = false) {
    const int width = job.width, height = job.height;
    const auto &layer = job.layer;
    const QImage &backdrop = job.backdrop;
    submitPoints(job);
    QImage output;
    if (live) output = captureLive(job);
    else { closeRender(job); output = layer->paintDevice()->convertToQImage(nullptr, 0, 0, width, height).convertToFormat(QImage::Format_ARGB32); }
    QImage coverage(width, height, QImage::Format_ARGB32);
    coverage.fill(Qt::transparent);
    for (int y = 0; y < height; ++y) {
        auto *row = reinterpret_cast<QRgb *>(output.scanLine(y));
        auto *mask = reinterpret_cast<QRgb *>(coverage.scanLine(y));
        const auto *before = backdrop.isNull() ? nullptr : reinterpret_cast<const QRgb *>(backdrop.constScanLine(y));
        for (int x = 0; x < width; ++x) {
            const bool changed = before ? row[x] != before[x] && (qAlpha(row[x]) || qAlpha(before[x])) : qAlpha(row[x]) != 0;
            if (changed) mask[x] = qRgba(255, 255, 255, 255);
            else row[x] = 0;
        }
    }
    return {{"width", width}, {"height", height}, {"png", encodePng(output)},
        {"coverage", encodePng(coverage)}, {"composited", !backdrop.isNull()}};
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
            else if (command == "presetInfo") response = presetInfo(request);
            else if (command == "render") { auto job = prepareRender(request); response = finishRender(*job); }
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

// Prepare resource snapshots on Qt's owner thread. Painting already uses Krita's
// scheduler; wait for it and encode PNGs off the UI thread. Destruct the image
// and deliver the result back on its owner thread, exactly once.
extern "C" void FKRenderAsync(const char *json, FKRenderCompletion completion, void *context) {
    struct Pending {
        std::shared_ptr<RenderJob> job;
        std::vector<std::shared_ptr<RenderJob>> retired;
        QString session;
        bool live = false, close = false, failed = false;
        int appended = 0;
        FKRenderCompletion completion;
        void *context;
        QByteArray bytes;
    };
    if (!completion) return;
    try {
        require(initialized && QThread::currentThread() == application->thread(), "The brush runtime is not ready on this thread.");
        require(!renderBusy, "The native renderer already has an active request.");
        require(json, "Missing request.");
        QJsonParseError error;
        const auto document = QJsonDocument::fromJson(QByteArray(json), &error);
        require(error.error == QJsonParseError::NoError && document.isObject(), "Malformed brush request.");
        const auto request = document.object();
        auto pending = std::make_unique<Pending>();
        pending->session = request["previewSession"].toString();
        require(pending->session.size() <= 128, "Invalid live stroke identifier.");
        pending->live = !pending->session.isEmpty(); pending->close = request["previewEnd"].toBool();
        require(!pending->close || pending->live, "Missing live stroke identifier.");
        auto previous = previewSessions.value(pending->session);
        if (pending->close) {
            if (previous) { pending->retired.push_back(previous); previewSessions.remove(pending->session); }
        } else {
            const int count = request["points"].toArray().size();
            require(count > 0 && count <= 10000, "Invalid stroke input.");
            if (pending->live && previous && canAppend(*previous, request)) {
                pending->job = previous;
                pending->appended = count - previous->submitted;
                previous->points = request["points"].toArray();
            } else {
                pending->job = prepareRender(request); pending->appended = count;
                if (previous) { pending->retired.push_back(previous); previewSessions.remove(pending->session); }
            }
            if (pending->live) {
                while (!previewSessions.contains(pending->session) && previewSessions.size() >= 4) {
                    auto old = previewSessions.begin(); pending->retired.push_back(old.value()); previewSessions.erase(old);
                }
                previewSessions.insert(pending->session, pending->job);
            }
        }
        pending->completion = completion; pending->context = context;
        renderBusy = true;
        dispatch_async_f(renderQueue(), pending.release(), [](void *raw) {
            auto *pending = static_cast<Pending *>(raw);
            QJsonObject response;
            try {
                for (auto &old : pending->retired) closeRender(*old);
                response = pending->close ? QJsonObject{{"closed", true}} : finishRender(*pending->job, pending->live);
                response["ok"] = true;
                if (pending->live && !pending->close) response["appendedPoints"] = pending->appended;
            }
            catch (const std::exception &e) { pending->failed = true; response = {{"ok", false}, {"error", QString::fromUtf8(e.what())}}; }
            catch (...) { pending->failed = true; response = {{"ok", false}, {"error", "The native brush renderer failed."}}; }
            if (pending->failed && pending->job) closeRender(*pending->job);
            pending->bytes = QJsonDocument(response).toJson(QJsonDocument::Compact);
            dispatch_async_f(dispatch_get_main_queue(), pending, [](void *raw) {
                std::unique_ptr<Pending> pending(static_cast<Pending *>(raw));
                if (pending->failed && previewSessions.value(pending->session) == pending->job) previewSessions.remove(pending->session);
                pending->retired.clear();
                pending->job.reset();
                renderBusy = false;
                pending->completion(pending->bytes.constData(), pending->context);
            });
        });
    } catch (const std::exception &e) {
        const QByteArray bytes = QJsonDocument(QJsonObject{{"ok", false}, {"error", QString::fromUtf8(e.what())}}).toJson(QJsonDocument::Compact);
        completion(bytes.constData(), context);
    } catch (...) {
        completion("{\"ok\":false,\"error\":\"Cannot prepare the native brush render.\"}", context);
    }
}
