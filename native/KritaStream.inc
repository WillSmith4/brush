// SPDX-License-Identifier: GPL-3.0-or-later
// Included inside the bridge namespace. One painter survives the entire input
// gesture; only dirty 256px tiles are copied to WebKit between batches.
void streamBarrier(RenderJob &job, const std::function<void()> &work) {
    if (!job.started) { work(); return; }
    struct Signal { std::mutex mutex; std::condition_variable ready; bool done=false; std::exception_ptr error; };
    auto signal=std::make_shared<Signal>();
    job.image->addJob(job.stroke,new KisRunnableStrokeJobData([signal,work] {
        try { work(); } catch (...) { signal->error=std::current_exception(); }
        { std::lock_guard<std::mutex> lock(signal->mutex);signal->done=true; }signal->ready.notify_one();
    },KisStrokeJobData::BARRIER));
    std::unique_lock<std::mutex> lock(signal->mutex);signal->ready.wait(lock,[&]{return signal->done;});
    if(signal->error)std::rethrow_exception(signal->error);
}

QString writeStreamPacket(const QByteArray &bytes) {
    const QString folder=storageRoot+"/PreviewPixels";require(QDir().mkpath(folder),"Cannot create live texture storage.");
    const QString token=QUuid::createUuid().toString(QUuid::WithoutBraces)+".rgba",path=folder+"/"+token;
    QFile file(path);require(file.open(QIODevice::WriteOnly)&&file.write(bytes)==bytes.size(),"Cannot write live texture tiles.");file.close();
    previewFiles.append(path);while(previewFiles.size()>8)QFile::remove(previewFiles.takeFirst());return token;
}

void streamImages(RenderJob &job,const KisPaintDeviceSP &device,const QRect &rect,QImage &color,QImage &coverage) {
    color=device->convertToQImage(nullptr,rect.x(),rect.y(),rect.width(),rect.height()).convertToFormat(QImage::Format_ARGB32);
    const QImage before=job.settings["streamBackdrop"].toBool()?job.base->convertToQImage(nullptr,rect.x(),rect.y(),rect.width(),rect.height()).convertToFormat(QImage::Format_ARGB32):QImage();
    coverage=QImage(rect.size(),QImage::Format_ARGB32);coverage.fill(Qt::transparent);
    for(int y=0;y<rect.height();++y){auto *row=reinterpret_cast<QRgb*>(color.scanLine(y));auto *mask=reinterpret_cast<QRgb*>(coverage.scanLine(y));const auto *base=before.isNull()?nullptr:reinterpret_cast<const QRgb*>(before.constScanLine(y));
        for(int x=0;x<rect.width();++x){const bool changed=base?row[x]!=base[x]&&(qAlpha(row[x])||qAlpha(base[x])):qAlpha(row[x])!=0;if(changed)mask[x]=qRgba(255,255,255,255);else row[x]=0;}
    }
}

QJsonObject renderStream(RenderJob &job,const QJsonObject &request) {
    require(job.streaming&&!job.ended,"The live stroke has ended.");
    const auto points=request["points"].toArray();
    require(request["streamFrom"].toInt(-1)==job.streamCount,"Out-of-order live stroke samples.");
    require(points.size()<=512,"Too many samples in one live batch.");
    for(const auto &p:points){const auto info=point(p.toArray());require(info.pos().x()>=0&&info.pos().x()<16384&&info.pos().y()>=0&&info.pos().y()<16384,"Live stroke exceeds the working surface.");}
    const auto backgrounds=request["streamTiles"].toArray();require(backgrounds.size()<=64,"Too many backdrop tiles.");
    streamBarrier(job,[&]{
        for(const auto &v:backgrounds){const auto t=v.toObject();const int x=t["x"].toInt(-1),y=t["y"].toInt(-1);require(x>=0&&y>=0&&x<16384&&y<16384&&x%256==0&&y%256==0,"Invalid backdrop tile.");const quint64 key=(quint64(x)<<32)|quint32(y);if(job.loadedTiles.contains(key))continue;
            const QByteArray bytes=QByteArray::fromBase64(t["png"].toString().toLatin1());require(bytes.size()<1048576,"Backdrop tile too large.");QImage image;require(image.loadFromData(bytes,"PNG")&&image.size()==QSize(256,256),"Invalid backdrop image.");
            job.base->convertFromQImage(image,nullptr,x,y);job.layer->paintDevice()->convertFromQImage(image,nullptr,x,y);job.loadedTiles.insert(key);
        }
    });
    if(!points.isEmpty()){
        QJsonArray addition;if(job.started)addition.append(job.points.last());for(const auto &p:points)addition.append(p);
        job.points=addition;job.submitted=job.started?1:0;submitPoints(job);job.streamCount+=points.size();
    }
    QRegion dirty;KisPaintDeviceSP device;
    streamBarrier(job,[&]{
        dirty=static_cast<StreamLayer*>(job.layer.data())->takeDirty();
        device=new KisPaintDevice(*job.layer->paintDevice());
    });
    for(const auto &r:dirty){const QRect clipped=r.intersected(QRect(0,0,16384,16384));job.paintedBounds|=clipped;
        for(int y=clipped.top()/256*256;y<=clipped.bottom();y+=256)for(int x=clipped.left()/256*256;x<=clipped.right();x+=256)job.pendingTiles.insert((quint64(x)<<32)|quint32(y));
    }
    if(request["streamFinish"].toBool()){
        closeRender(job);const QRect bounds=job.paintedBounds.isEmpty()?QRect(8192,8192,1,1):job.paintedBounds;
        const double scale=std::min({1.0,4094.0/bounds.width(),4094.0/bounds.height(),std::sqrt(2090000.0/(double(bounds.width())*bounds.height()))});
        const QSize size(std::max(1,int(std::ceil(bounds.width()*scale))),std::max(1,int(std::ceil(bounds.height()*scale))));
        QImage output(size,QImage::Format_ARGB32_Premultiplied),mask(size,QImage::Format_ARGB32_Premultiplied);output.fill(Qt::transparent);mask.fill(Qt::transparent);
        QPainter out(&output),coverage(&mask);out.setCompositionMode(QPainter::CompositionMode_Source);coverage.setCompositionMode(QPainter::CompositionMode_Source);out.setRenderHint(QPainter::SmoothPixmapTransform);coverage.setRenderHint(QPainter::SmoothPixmapTransform);
        for(int y=bounds.top()/256*256;y<=bounds.bottom();y+=256)for(int x=bounds.left()/256*256;x<=bounds.right();x+=256){const QRect rect=QRect(x,y,256,256).intersected(bounds);QImage c,m;streamImages(job,job.layer->paintDevice(),rect,c,m);const QRectF target((rect.x()-bounds.x())*scale,(rect.y()-bounds.y())*scale,rect.width()*scale,rect.height()*scale);out.drawImage(target,c);coverage.drawImage(target,m);}
        out.end();coverage.end();
        return {{"width",size.width()},{"height",size.height()},{"png",encodePng(output)},{"coverage",encodePng(mask)},{"composited",job.settings["streamBackdrop"].toBool()},{"streamCount",job.streamCount},{"streamScale",scale},{"streamX",bounds.x()},{"streamY",bounds.y()}};
    }
    // Delayed dirty tiles need the complete current indirect layer, not just
    // this batch's dirty region. Snapshot those tiles while the painter is idle.
    if(job.layer->hasTemporaryTarget())streamBarrier(job,[&]{KisIndirectPaintingSupport::ReadLocker lock(job.layer.data());KisPainter painter(device);job.layer->setupTemporaryPainter(&painter);QRegion region;for(const auto key:job.pendingTiles)region+=QRect(int(key>>32)-1,int(quint32(key))-1,258,258);for(const auto &r:region)painter.bitBlt(r.topLeft(),job.layer->temporaryTarget(),r);});
    QByteArray packet;QJsonArray tiles;
    const auto keys=job.pendingTiles.values();int count=0;
    for(const auto key:keys){if(count++==16)break;const int x=int(key>>32),y=int(quint32(key));const QRect rect(x-1,y-1,258,258);QImage color,coverage;streamImages(job,device,rect,color,coverage);const int offset=packet.size();const QImage rgba=color.convertToFormat(QImage::Format_RGBA8888);
        for(int row=0;row<258;++row)packet.append(reinterpret_cast<const char*>(rgba.constScanLine(row)),258*4);
        for(int row=0;row<258;++row){const auto *m=reinterpret_cast<const QRgb*>(coverage.constScanLine(row));for(int col=0;col<258;++col)packet.append(char(qAlpha(m[col])));}
        tiles.append(QJsonObject{{"x",x-1},{"y",y-1},{"width",258},{"height",258},{"offset",offset}});job.pendingTiles.remove(key);
    }
    return {{"tiles",tiles},{"pixels",packet.isEmpty()?QString():writeStreamPacket(packet)},{"streamCount",job.streamCount},{"pendingTiles",!job.pendingTiles.isEmpty()},{"composited",job.settings["streamBackdrop"].toBool()}};
}
