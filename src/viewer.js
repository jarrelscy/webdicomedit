function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeWindowedPixels(image, windowCenter, windowWidth) {
  const pixels = image.pixelArray;
  const slope = image.rescaleSlope ?? 1;
  const intercept = image.rescaleIntercept ?? 0;
  const invert = image.photometricInterpretation === 'MONOCHROME1';
  const output = new Uint8ClampedArray(image.rows * image.columns * 4);
  const width = Math.max(windowWidth ?? image.defaultWindowWidth ?? 1, 1);
  const center = windowCenter ?? image.defaultWindowCenter ?? 0;
  const min = center - width / 2;
  const max = center + width / 2;
  let idx = 0;
  for (let i = 0; i < pixels.length; i++) {
    const hu = pixels[i] * slope + intercept;
    let value = clamp((hu - min) / (max - min || 1), 0, 1);
    if (invert) {
      value = 1 - value;
    }
    const gray = Math.round(value * 255);
    output[idx++] = gray;
    output[idx++] = gray;
    output[idx++] = gray;
    output[idx++] = 255;
  }
  return output;
}

function computeStats(image) {
  const pixels = image.pixelArray;
  const slope = image.rescaleSlope ?? 1;
  const intercept = image.rescaleIntercept ?? 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i] * slope + intercept;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const mean = sum / pixels.length;
  return { min, max, mean };
}

function ensureImageDefaults(image) {
  if (image.stats) {
    return;
  }
  const stats = computeStats(image);
  image.stats = stats;
  if (image.windowCenter == null || image.windowWidth == null) {
    const windowWidth = Math.max(stats.max - stats.min, 1);
    image.defaultWindowCenter = (stats.max + stats.min) / 2;
    image.defaultWindowWidth = windowWidth;
  } else {
    image.defaultWindowCenter = image.windowCenter;
    image.defaultWindowWidth = Math.max(image.windowWidth, 1);
  }
}

class Viewer {
  constructor(canvas, overlayCanvas, infoBox, saveManager) {
    this.canvas = canvas;
    this.overlayCanvas = overlayCanvas;
    this.infoBox = infoBox;
    this.ctx = canvas.getContext('2d');
    this.overlayCtx = overlayCanvas.getContext('2d');
    this.saveManager = saveManager;
    this.imageChangeListeners = new Set();
    this.brushChangeListeners = new Set();

    this.currentSeries = null;
    this.currentImageIndex = 0;
    this.windowCenter = null;
    this.windowWidth = null;
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.activeTool = 'window';
    this.isDragging = false;
    this.lastPointer = null;
    this.brushSize = 20;
    this.brushIntensity = 4000;
    this.selection = null;
    this.clipboard = null;
    this.selectionRect = document.createElement('div');
    this.selectionRect.className = 'selection-rect';
    this.selectionVisible = false;
    this.pointerTarget = null;
    this.stackDragAccumulator = 0;

    this.container = canvas.parentElement;
    this.container.appendChild(this.selectionRect);
    this.selectionRect.style.display = 'none';

    this.activePaste = null;
    this.pasteRect = document.createElement('div');
    this.pasteRect.className = 'paste-rect';
    this.pasteRect.style.display = 'none';
    this.pasteCanvasElement = document.createElement('canvas');
    this.pasteCanvasElement.className = 'paste-canvas';
    this.pasteCtx = this.pasteCanvasElement.getContext('2d');
    this.pasteRect.appendChild(this.pasteCanvasElement);
    this.container.appendChild(this.pasteRect);

    this.initEvents();
    this.updateOverlayPointerEvents();
  }

  setTool(tool) {
    this.activeTool = tool;
    this.updateOverlayPointerEvents();
  }

  setBrushSettings(size, intensity) {
    if (Number.isFinite(size)) {
      this.brushSize = clamp(size, 1, 1024);
    }
    if (Number.isFinite(intensity)) {
      this.brushIntensity = intensity;
    }
    this.notifyBrushChange();
  }

  onBrushSettingsChange(callback) {
    this.brushChangeListeners.add(callback);
  }

  notifyBrushChange() {
    for (const cb of this.brushChangeListeners) {
      try {
        cb(this.brushSize, this.brushIntensity);
      } catch (error) {
        console.log('[Viewer] brush listener error', error);
      }
    }
  }

  updateOverlayPointerEvents() {
    const requiresPointer =
      this.activeTool === 'brush' ||
      this.activeTool === 'select' ||
      this.activeTool === 'eyedropper' ||
      !!this.activePaste;
    this.overlayCanvas.style.pointerEvents = requiresPointer ? 'auto' : 'none';
  }

  setSeries(series) {
    this.currentSeries = series;
    this.currentImageIndex = 0;
    this.cancelActivePaste();
    this.hideSelection();
    for (const image of series.instances) {
      ensureImageDefaults(image);
    }
    this.resetView();
    this.render();
    this.notifyImageChange();
  }

  resetView() {
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.windowCenter = null;
    this.windowWidth = null;
  }

  get currentImage() {
    if (!this.currentSeries) return null;
    return this.currentSeries.instances[this.currentImageIndex];
  }

  setImageIndex(index) {
    if (!this.currentSeries) return;
    const clamped = clamp(index, 0, this.currentSeries.instances.length - 1);
    this.currentImageIndex = clamped;
    if (this.selection && this.selection.captureZ) {
      const previousBounds = { zMin: this.selection.zMin, zMax: this.selection.zMax };
      this.selection.zMin = Math.min(this.selection.zMin, clamped);
      this.selection.zMax = Math.max(this.selection.zMax, clamped);
      if (
        previousBounds.zMin !== this.selection.zMin ||
        previousBounds.zMax !== this.selection.zMax
      ) {
        console.log('[Viewer] selection z-bounds updated', {
          zMin: this.selection.zMin,
          zMax: this.selection.zMax,
          currentSlice: clamped,
        });
      }
    }
    if (this.activePaste) {
      const mid = Math.floor(this.activePaste.depth / 2);
      this.activePaste.zBase = clamped - mid;
      console.log('[Viewer] paste z-base adjusted', {
        depth: this.activePaste.depth,
        zBase: this.activePaste.zBase,
        currentSlice: clamped,
      });
    }
    this.render();
    this.notifyImageChange();
  }

  nextImage(step = 1) {
    this.setImageIndex(this.currentImageIndex + step);
  }

  prevImage(step = 1) {
    this.setImageIndex(this.currentImageIndex - step);
  }

  applyBrush(image, coords) {
    const { rows, columns, pixelArray } = image;
    const radius = this.brushSize / 2;
    const [cx, cy] = coords;
    const minX = Math.floor(clamp(cx - radius, 0, columns - 1));
    const maxX = Math.floor(clamp(cx + radius, 0, columns - 1));
    const minY = Math.floor(clamp(cy - radius, 0, rows - 1));
    const maxY = Math.floor(clamp(cy + radius, 0, rows - 1));
    const rSquared = radius * radius;
    const minValue = image.minStoredValue ?? 0;
    const maxValue = image.maxStoredValue ?? 65535;
    const brushValue = clamp(this.brushIntensity, minValue, maxValue);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= rSquared) {
          pixelArray[y * columns + x] = brushValue;
        }
      }
    }
    image.dirty = true;
    this.saveManager.markDirty(image);
  }

  startSelection(startCoords) {
    this.selection = {
      start: startCoords,
      end: startCoords,
      zMin: this.currentImageIndex,
      zMax: this.currentImageIndex,
      captureZ: true,
    };
    this.updateSelectionRect();
  }

  updateSelection(endCoords) {
    if (!this.selection) return;
    this.selection.end = endCoords;
    this.updateSelectionRect();
  }

  finishSelection() {
    if (!this.selection) return;
    const { start, end } = this.selection;
    const minX = Math.min(start[0], end[0]);
    const minY = Math.min(start[1], end[1]);
    const maxX = Math.max(start[0], end[0]);
    const maxY = Math.max(start[1], end[1]);
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 1 || height < 1) {
      this.selection = null;
      this.hideSelection();
      return;
    }
    this.selection = {
      start: [minX, minY],
      end: [maxX, maxY],
      zMin: this.selection.zMin,
      zMax: this.selection.zMax,
      captureZ: true,
    };
    console.log('[Viewer] selection finalized', {
      start: this.selection.start,
      end: this.selection.end,
      zMin: this.selection.zMin,
      zMax: this.selection.zMax,
    });
    this.updateSelectionRect();
  }

  hideSelection() {
    this.selection = null;
    this.selectionRect.style.display = 'none';
  }

  cancelActivePaste() {
    if (!this.activePaste) {
      return;
    }
    console.log('[Viewer] cancelling active paste');
    this.activePaste = null;
    this.pasteRect.style.display = 'none';
    this.updateOverlayPointerEvents();
  }

  refreshPastePreview() {
    if (!this.activePaste || !this.currentImage) {
      return;
    }
    const { width, height, region, depth, zBase } = this.activePaste;
    const sliceIndex = this.currentImageIndex - zBase;
    if (sliceIndex < 0 || sliceIndex >= depth) {
      this.pasteRect.style.display = 'none';
      return;
    }
    const image = this.currentImage;
    const windowCenter = this.windowCenter ?? image.defaultWindowCenter;
    const windowWidth = this.windowWidth ?? image.defaultWindowWidth;
    this.pasteCanvasElement.width = width;
    this.pasteCanvasElement.height = height;
    const previewImage = {
      pixelArray: region.subarray(sliceIndex * width * height, (sliceIndex + 1) * width * height),
      rows: height,
      columns: width,
      rescaleSlope: image.rescaleSlope,
      rescaleIntercept: image.rescaleIntercept,
      photometricInterpretation: image.photometricInterpretation,
      defaultWindowCenter: windowCenter,
      defaultWindowWidth: windowWidth,
    };
    const data = computeWindowedPixels(previewImage, windowCenter, windowWidth);
    const imageData = this.pasteCtx.createImageData(width, height);
    imageData.data.set(data);
    this.pasteCtx.putImageData(imageData, 0, 0);
    console.log('[Viewer] paste preview refreshed', {
      width,
      height,
      depth,
      sliceIndex,
      windowCenter,
      windowWidth,
    });
  }

  updatePasteOverlay() {
    if (!this.activePaste || !this.currentImage) {
      this.pasteRect.style.display = 'none';
      return;
    }
    const { position, width, height, depth, zBase } = this.activePaste;
    const sliceIndex = this.currentImageIndex - zBase;
    if (sliceIndex < 0 || sliceIndex >= depth) {
      this.pasteRect.style.display = 'none';
      return;
    }
    const canvasRect = this.canvas.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const scaleX = canvasRect.width / this.canvas.width || 1;
    const scaleY = canvasRect.height / this.canvas.height || 1;
    const left = canvasRect.left - containerRect.left + position.x * scaleX;
    const top = canvasRect.top - containerRect.top + position.y * scaleY;
    const displayWidth = width * scaleX;
    const displayHeight = height * scaleY;
    this.pasteRect.style.display = 'block';
    this.pasteRect.style.left = `${left}px`;
    this.pasteRect.style.top = `${top}px`;
    this.pasteRect.style.width = `${displayWidth}px`;
    this.pasteRect.style.height = `${displayHeight}px`;
    console.log('[Viewer] paste overlay updated', {
      position,
      sliceIndex,
      depth,
      display: { left, top, width: displayWidth, height: displayHeight },
    });
  }

  commitActivePaste() {
    if (!this.activePaste || !this.currentImage) {
      console.log('[Viewer] no active paste to commit');
      return false;
    }
    const { position, region, width, height, depth, zBase } = this.activePaste;
    const startX = Math.floor(position.x);
    const startY = Math.floor(position.y);
    for (let z = 0; z < depth; z++) {
      const sliceIndex = zBase + z;
      if (sliceIndex < 0 || sliceIndex >= this.currentSeries.instances.length) {
        continue;
      }
      const targetImage = this.currentSeries.instances[sliceIndex];
      const { columns, rows, pixelArray } = targetImage;
      for (let y = 0; y < height; y++) {
        const yy = startY + y;
        if (yy < 0 || yy >= rows) {
          continue;
        }
        for (let x = 0; x < width; x++) {
          const xx = startX + x;
          if (xx < 0 || xx >= columns) {
            continue;
          }
          const destIndex = yy * columns + xx;
          const srcIndex = z * width * height + y * width + x;
          pixelArray[destIndex] = region[srcIndex];
        }
      }
      targetImage.dirty = true;
      this.saveManager.markDirty(targetImage);
      console.log('[Viewer] paste applied to slice', {
        sliceIndex,
        startX,
        startY,
        width,
        height,
      });
    }
    console.log('[Viewer] paste committed', {
      position: { startX, startY },
      width,
      height,
      depth,
      zBase,
    });
    this.activePaste = null;
    this.clipboard = null;
    this.pasteRect.style.display = 'none';
    this.render();
    this.updateOverlayPointerEvents();
    return true;
  }

  copySelection() {
    if (!this.selection || !this.currentSeries) {
      console.log('[Viewer] copy skipped - no selection available');
      return false;
    }
    const { start, end } = this.selection;
    const minX = Math.floor(Math.min(start[0], end[0]));
    const minY = Math.floor(Math.min(start[1], end[1]));
    const maxX = Math.ceil(Math.max(start[0], end[0]));
    const maxY = Math.ceil(Math.max(start[1], end[1]));
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const zMin = Math.min(this.selection.zMin ?? this.currentImageIndex, this.selection.zMax ?? this.currentImageIndex);
    const zMax = Math.max(this.selection.zMin ?? this.currentImageIndex, this.selection.zMax ?? this.currentImageIndex);
    const depth = Math.max(zMax - zMin + 1, 1);
    const region = new Uint16Array(width * height * depth);
    for (let z = 0; z < depth; z++) {
      const sliceIndex = zMin + z;
      const image = this.currentSeries.instances[sliceIndex];
      if (!image) {
        console.log('[Viewer] skip missing slice during copy', { sliceIndex });
        continue;
      }
      const { columns, pixelArray } = image;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIndex = (minY + y) * columns + (minX + x);
          const destIndex = z * width * height + y * width + x;
          region[destIndex] = pixelArray[srcIndex];
        }
      }
    }
    this.clipboard = { region, width, height, depth, zMin, zMax };
    console.log('[Viewer] selection copied', { width, height, depth, zMin, zMax });
    this.hideSelection();
    return true;
  }

  beginPasteFromClipboard(centerCoords = null) {
    if (!this.clipboard || !this.currentImage) {
      console.log('[Viewer] paste skipped - clipboard empty or no image');
      return false;
    }
    const depth = this.clipboard.depth ?? 1;
    this.activePaste = {
      position: { x: 0, y: 0 },
      region: this.clipboard.region.slice(0),
      width: this.clipboard.width,
      height: this.clipboard.height,
      depth,
      zBase: this.currentImageIndex - Math.floor(depth / 2),
      dragging: false,
      dragOffset: { x: 0, y: 0 },
    };
    const targetCenter =
      centerCoords ?? [this.currentImage.columns / 2, this.currentImage.rows / 2];
    console.log('[Viewer] paste initiated', {
      center: targetCenter,
      width: this.activePaste.width,
      height: this.activePaste.height,
      depth: this.activePaste.depth,
      zBase: this.activePaste.zBase,
    });
    this.moveActivePasteCenter(targetCenter);
    this.updateOverlayPointerEvents();
    return true;
  }

  hasActivePaste() {
    return !!this.activePaste;
  }

  moveActivePasteCenter(centerCoords) {
    if (!this.activePaste || !this.currentImage) {
      return;
    }
    const [cx, cy] = centerCoords;
    const { width, height, depth } = this.activePaste;
    this.activePaste.position = {
      x: cx - width / 2,
      y: cy - height / 2,
    };
    this.activePaste.zBase = this.currentImageIndex - Math.floor(depth / 2);
    this.activePaste.dragging = false;
    this.activePaste.dragOffset = { x: 0, y: 0 };
    console.log('[Viewer] paste center moved', {
      center: { x: cx, y: cy, z: this.currentImageIndex },
      position: this.activePaste.position,
      depth,
      zBase: this.activePaste.zBase,
    });
    this.refreshPastePreview();
    this.updatePasteOverlay();
  }

  sampleBrushIntensity(coords) {
    const image = this.currentImage;
    if (!image) {
      return;
    }
    const [x, y] = coords;
    const ix = clamp(Math.round(x), 0, image.columns - 1);
    const iy = clamp(Math.round(y), 0, image.rows - 1);
    const value = image.pixelArray[iy * image.columns + ix];
    console.log('[Viewer] eyedropper sampled', { x: ix, y: iy, value });
    this.setBrushSettings(this.brushSize, value);
  }

  coordsFromPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width / this.canvas.width || 1;
    const scaleY = rect.height / this.canvas.height || 1;
    const x = (event.clientX - rect.left) / scaleX;
    const y = (event.clientY - rect.top) / scaleY;
    return [x, y];
  }

  drawImage() {
    const image = this.currentImage;
    if (!image) return;
    const { columns, rows } = image;
    const canvas = this.canvas;
    canvas.width = columns;
    canvas.height = rows;

    const imageData = this.ctx.createImageData(columns, rows);
    const windowed = computeWindowedPixels(
      image,
      this.windowCenter ?? image.defaultWindowCenter,
      this.windowWidth ?? image.defaultWindowWidth,
    );
    imageData.data.set(windowed);
    this.ctx.putImageData(imageData, 0, 0);

    this.canvas.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
    this.overlayCanvas.width = columns;
    this.overlayCanvas.height = rows;
    this.overlayCanvas.style.transform = this.canvas.style.transform;

    this.overlayCtx.clearRect(0, 0, columns, rows);
  }

  updateInfo() {
    const image = this.currentImage;
    if (!image) {
      this.infoBox.textContent = 'No image loaded';
      return;
    }
    const { seriesNumber, seriesDescription } = this.currentSeries;
    const { instanceNumber, stats } = image;
    this.infoBox.innerHTML = `Series ${seriesNumber} - ${seriesDescription}<br />Slice ${instanceNumber}<br />Min: ${stats.min.toFixed(
      1,
    )} Max: ${stats.max.toFixed(1)} Mean: ${stats.mean.toFixed(1)}`;
  }

  render() {
    this.drawImage();
    if (this.selection) {
      this.updateSelectionRect();
    } else {
      this.selectionRect.style.display = 'none';
    }
    this.refreshPastePreview();
    this.updatePasteOverlay();
    this.updateInfo();
  }

  onImageChange(callback) {
    this.imageChangeListeners.add(callback);
  }

  notifyImageChange() {
    for (const cb of this.imageChangeListeners) {
      cb(this.currentImage, this.currentSeries);
    }
  }

  setWindowPreset(center, width) {
    const image = this.currentImage;
    if (!image) return;
    this.windowCenter = Number.isFinite(center) ? center : image.defaultWindowCenter;
    this.windowWidth = clamp(Number.isFinite(width) ? width : image.defaultWindowWidth, 1, 5000);
    this.render();
  }

  adjustWindow(deltaX, deltaY) {
    const image = this.currentImage;
    if (!image) return;
    const factor = 0.5;
    this.windowCenter = (this.windowCenter ?? image.defaultWindowCenter) + deltaY * factor;
    this.windowWidth = clamp(
      (this.windowWidth ?? image.defaultWindowWidth) + deltaX * factor,
      1,
      5000,
    );
    this.render();
  }

  adjustPan(deltaX, deltaY) {
    this.offset.x += deltaX;
    this.offset.y += deltaY;
    this.canvas.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
    this.overlayCanvas.style.transform = this.canvas.style.transform;
    this.updateSelectionRect();
    this.updatePasteOverlay();
  }

  adjustZoom(deltaY, center) {
    const zoomFactor = 1 + deltaY * -0.001;
    this.scale = clamp(this.scale * zoomFactor, 0.1, 10);
    this.canvas.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
    this.overlayCanvas.style.transform = this.canvas.style.transform;
    this.updateSelectionRect();
    this.updatePasteOverlay();
  }

  updateSelectionRect() {
    if (!this.selection) {
      this.selectionRect.style.display = 'none';
      console.log('[Viewer] selection rect hidden');
      return;
    }
    const { start, end } = this.selection;
    const minX = Math.min(start[0], end[0]);
    const minY = Math.min(start[1], end[1]);
    const width = Math.abs(end[0] - start[0]);
    const height = Math.abs(end[1] - start[1]);
    const canvasRect = this.canvas.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const scaleX = canvasRect.width / this.canvas.width || 1;
    const scaleY = canvasRect.height / this.canvas.height || 1;
    const left = canvasRect.left - containerRect.left + minX * scaleX;
    const top = canvasRect.top - containerRect.top + minY * scaleY;
    const displayWidth = width * scaleX;
    const displayHeight = height * scaleY;
    this.selectionRect.style.display = 'block';
    this.selectionRect.style.left = `${left}px`;
    this.selectionRect.style.top = `${top}px`;
    this.selectionRect.style.width = `${displayWidth}px`;
    this.selectionRect.style.height = `${displayHeight}px`;
    console.log('[Viewer] selection rect updated', {
      start,
      end,
      display: { left, top, width: displayWidth, height: displayHeight },
    });
  }

  initEvents() {
    const handlePointerDown = (event) => {
      if (!this.currentImage) {
        return;
      }
      const coords = this.coordsFromPointer(event);

      if (this.activePaste) {
        const sliceIndex = this.currentImageIndex - this.activePaste.zBase;
        if (sliceIndex < 0 || sliceIndex >= this.activePaste.depth) {
          console.log('[Viewer] realigning paste volume for current slice', {
            sliceIndex,
            depth: this.activePaste.depth,
          });
          this.activePaste.zBase = this.currentImageIndex - Math.floor(this.activePaste.depth / 2);
        }
        const { position, width, height } = this.activePaste;
        const inside =
          coords[0] >= position.x &&
          coords[0] <= position.x + width &&
          coords[1] >= position.y &&
          coords[1] <= position.y + height;
        if (!inside) {
          console.log('[Viewer] moving paste center from click');
          this.moveActivePasteCenter(coords);
          return;
        }
        this.activePaste.dragging = true;
        this.activePaste.dragOffset = {
          x: coords[0] - position.x,
          y: coords[1] - position.y,
        };
        this.lastPointer = { x: event.clientX, y: event.clientY };
        this.isDragging = true;
        if (event.target.setPointerCapture) {
          try {
            event.target.setPointerCapture(event.pointerId);
            this.pointerTarget = event.target;
            console.log('[Viewer] pointer captured', {
              pointerId: event.pointerId,
              target: event.target.tagName,
              tool: 'paste',
            });
          } catch (error) {
            console.log('[Viewer] pointer capture failed', error);
          }
        }
        console.log('[Viewer] paste drag started', {
          coords,
          offset: this.activePaste.dragOffset,
        });
        return;
      }

      this.isDragging = true;
      if (event.target.setPointerCapture) {
        try {
          event.target.setPointerCapture(event.pointerId);
          this.pointerTarget = event.target;
          console.log('[Viewer] pointer captured', {
            pointerId: event.pointerId,
            target: event.target.tagName,
            tool: this.activeTool,
          });
        } catch (error) {
          console.log('[Viewer] pointer capture failed', error);
        }
      }
      this.lastPointer = { x: event.clientX, y: event.clientY };
      if (this.activeTool === 'stack') {
        this.stackDragAccumulator = 0;
      }
      if (this.activeTool === 'brush') {
        this.applyBrush(this.currentImage, coords);
        this.render();
      } else if (this.activeTool === 'select') {
        this.startSelection(coords);
      } else if (this.activeTool === 'eyedropper') {
        this.sampleBrushIntensity(coords);
      }
    };

    const handlePointerMove = (event) => {
      if (!this.currentImage) {
        return;
      }

      const coords = this.coordsFromPointer(event);

      if (this.activePaste && this.activePaste.dragging) {
        const sliceIndex = this.currentImageIndex - this.activePaste.zBase;
        if (sliceIndex < 0 || sliceIndex >= this.activePaste.depth) {
          console.log('[Viewer] skipping paste drag outside active volume', {
            sliceIndex,
            depth: this.activePaste.depth,
          });
          return;
        }
        this.activePaste.position = {
          x: coords[0] - this.activePaste.dragOffset.x,
          y: coords[1] - this.activePaste.dragOffset.y,
        };
        this.updatePasteOverlay();
        return;
      }

      if (this.activeTool === 'brush' && this.isDragging) {
        this.applyBrush(this.currentImage, coords);
        this.render();
      } else if (this.activeTool === 'window' && this.isDragging) {
        const dx = event.clientX - this.lastPointer.x;
        const dy = event.clientY - this.lastPointer.y;
        this.adjustWindow(dx, dy);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'pan' && this.isDragging) {
        const dx = event.clientX - this.lastPointer.x;
        const dy = event.clientY - this.lastPointer.y;
        this.adjustPan(dx, dy);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'stack' && this.isDragging) {
        const dy = event.clientY - this.lastPointer.y;
        this.stackDragAccumulator += dy;
        const pixelsPerSlice = 12;
        while (Math.abs(this.stackDragAccumulator) >= pixelsPerSlice) {
          const direction = this.stackDragAccumulator > 0 ? 1 : -1;
          this.nextImage(direction);
          this.stackDragAccumulator -= direction * pixelsPerSlice;
        }
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'zoom' && this.isDragging) {
        const dy = event.clientY - this.lastPointer.y;
        this.adjustZoom(dy, coords);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'select' && this.isDragging) {
        if (!this.selection) {
          return;
        }
        this.updateSelection(coords);
      } else if (this.activeTool === 'eyedropper' && this.isDragging) {
        this.sampleBrushIntensity(coords);
      }
    };

    const handlePointerUp = (event) => {
      if (this.activePaste && this.activePaste.dragging) {
        this.activePaste.dragging = false;
        console.log('[Viewer] paste drag finished', { position: this.activePaste.position });
      } else if (this.activeTool === 'select' && this.selection) {
        this.finishSelection();
      }
      this.isDragging = false;
      this.stackDragAccumulator = 0;
      if (this.pointerTarget && this.pointerTarget.releasePointerCapture) {
        try {
          if (event && typeof event.pointerId === 'number') {
            this.pointerTarget.releasePointerCapture(event.pointerId);
          }
          console.log('[Viewer] pointer released', {
            pointerId: event?.pointerId,
            target: this.pointerTarget.tagName,
          });
        } catch (error) {
          console.log('[Viewer] pointer release failed', error);
        }
      }
      this.pointerTarget = null;
    };

    const handleWheel = (event) => {
      if (!this.currentSeries) return;
      event.preventDefault();
      if (event.ctrlKey || this.activeTool === 'zoom') {
        this.adjustZoom(event.deltaY, [event.clientX, event.clientY]);
      } else {
        const direction = event.deltaY > 0 ? 1 : -1;
        this.nextImage(direction);
      }
    };

    this.overlayCanvas.addEventListener('pointerdown', handlePointerDown);
    this.overlayCanvas.addEventListener('pointermove', handlePointerMove);
    this.overlayCanvas.addEventListener('pointerup', handlePointerUp);
    this.overlayCanvas.addEventListener('pointerleave', handlePointerUp);
    this.overlayCanvas.addEventListener('pointercancel', handlePointerUp);
    this.canvas.addEventListener('pointerdown', handlePointerDown);
    this.canvas.addEventListener('pointermove', handlePointerMove);
    this.canvas.addEventListener('pointerup', handlePointerUp);
    this.canvas.addEventListener('pointerleave', handlePointerUp);
    this.canvas.addEventListener('pointercancel', handlePointerUp);
    this.canvas.addEventListener('wheel', handleWheel, { passive: false });
    this.overlayCanvas.addEventListener('wheel', handleWheel, { passive: false });

    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (!this.currentSeries) return;
      if (event.key === 'ArrowUp') {
        this.prevImage();
      } else if (event.key === 'ArrowDown') {
        this.nextImage();
      }
    });
  }
}

export { Viewer, computeWindowedPixels, ensureImageDefaults };
