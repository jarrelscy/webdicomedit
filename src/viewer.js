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

    this.container = canvas.parentElement;
    this.container.appendChild(this.selectionRect);
    this.selectionRect.style.display = 'none';

    this.initEvents();
  }

  setTool(tool) {
    this.activeTool = tool;
    if (tool === 'brush' || tool === 'select') {
      this.overlayCanvas.style.pointerEvents = 'auto';
    } else {
      this.overlayCanvas.style.pointerEvents = 'none';
    }
    if (tool !== 'select') {
      this.hideSelection();
    }
  }

  setBrushSettings(size, intensity) {
    this.brushSize = size;
    this.brushIntensity = intensity;
  }

  setSeries(series) {
    this.currentSeries = series;
    this.currentImageIndex = 0;
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
    const image = this.currentImage;
    const { columns, pixelArray } = image;
    const region = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIndex = (minY + y) * columns + (minX + x);
        region[y * width + x] = pixelArray[srcIndex];
      }
    }
    this.clipboard = { region, width, height };
    this.selection = { start: [minX, minY], end: [maxX, maxY] };
    this.updateSelectionRect();
  }

  hideSelection() {
    this.selection = null;
    this.selectionRect.style.display = 'none';
  }

  copySelection() {
    if (!this.selection) return;
    const { start, end } = this.selection;
    const minX = Math.floor(Math.min(start[0], end[0]));
    const minY = Math.floor(Math.min(start[1], end[1]));
    const maxX = Math.ceil(Math.max(start[0], end[0]));
    const maxY = Math.ceil(Math.max(start[1], end[1]));
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const image = this.currentImage;
    if (!image) return;
    const { columns, pixelArray } = image;
    const region = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIndex = (minY + y) * columns + (minX + x);
        region[y * width + x] = pixelArray[srcIndex];
      }
    }
    this.clipboard = { region, width, height };
  }

  pasteClipboard(targetCoords) {
    if (!this.clipboard) return;
    const image = this.currentImage;
    const { columns, rows, pixelArray } = image;
    const { region, width, height } = this.clipboard;
    const startX = Math.floor(targetCoords[0]);
    const startY = Math.floor(targetCoords[1]);
    for (let y = 0; y < height; y++) {
      const yy = startY + y;
      if (yy < 0 || yy >= rows) continue;
      for (let x = 0; x < width; x++) {
        const xx = startX + x;
        if (xx < 0 || xx >= columns) continue;
        const destIndex = yy * columns + xx;
        const srcIndex = y * width + x;
        pixelArray[destIndex] = region[srcIndex];
      }
    }
    image.dirty = true;
    this.saveManager.markDirty(image);
  }

  coordsFromPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - this.offset.x;
    const y = event.clientY - rect.top - this.offset.y;
    const scale = this.scale * (this.canvas.width / this.currentImage.columns);
    return [x / scale, y / scale];
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
  }

  adjustZoom(deltaY, center) {
    const zoomFactor = 1 + deltaY * -0.001;
    this.scale = clamp(this.scale * zoomFactor, 0.1, 10);
    this.canvas.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
    this.overlayCanvas.style.transform = this.canvas.style.transform;
    this.updateSelectionRect();
  }

  updateSelectionRect() {
    if (!this.selection) {
      this.selectionRect.style.display = 'none';
      return;
    }
    const { start, end } = this.selection;
    const minX = Math.min(start[0], end[0]);
    const minY = Math.min(start[1], end[1]);
    const width = Math.abs(end[0] - start[0]);
    const height = Math.abs(end[1] - start[1]);
    const scale = this.scale * (this.canvas.width / this.currentImage.columns);
    this.selectionRect.style.display = 'block';
    this.selectionRect.style.left = `${this.canvas.offsetLeft + this.offset.x + minX * scale}px`;
    this.selectionRect.style.top = `${this.canvas.offsetTop + this.offset.y + minY * scale}px`;
    this.selectionRect.style.width = `${width * scale}px`;
    this.selectionRect.style.height = `${height * scale}px`;
  }

  initEvents() {
    const handlePointerDown = (event) => {
      if (!this.currentImage) return;
      this.isDragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      const coords = this.coordsFromPointer(event);
      if (this.activeTool === 'brush') {
        this.applyBrush(this.currentImage, coords);
        this.render();
      } else if (this.activeTool === 'select') {
        this.startSelection(coords);
      }
    };

    const handlePointerMove = (event) => {
      if (!this.currentImage) {
        console.log('[Viewer] pointermove ignored - no current image', {
          tool: this.activeTool,
          isDragging: this.isDragging,
        });
        return;
      }

      const coords = this.coordsFromPointer(event);
      console.log('[Viewer] pointermove received', {
        tool: this.activeTool,
        isDragging: this.isDragging,
        coords,
        pointer: { x: event.clientX, y: event.clientY },
      });

      if (this.activeTool === 'brush' && this.isDragging) {
        console.log('[Viewer] pointermove -> brush update');
        this.applyBrush(this.currentImage, coords);
        this.render();
      } else if (this.activeTool === 'window' && this.isDragging) {
        const dx = event.clientX - this.lastPointer.x;
        const dy = event.clientY - this.lastPointer.y;
        console.log('[Viewer] pointermove -> window adjust', { dx, dy });
        this.adjustWindow(dx, dy);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'pan' && this.isDragging) {
        const dx = event.clientX - this.lastPointer.x;
        const dy = event.clientY - this.lastPointer.y;
        console.log('[Viewer] pointermove -> pan adjust', { dx, dy });
        this.adjustPan(dx, dy);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'zoom' && this.isDragging) {
        const dy = event.clientY - this.lastPointer.y;
        console.log('[Viewer] pointermove -> zoom adjust', { dy });
        this.adjustZoom(dy, coords);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      } else if (this.activeTool === 'select' && this.isDragging) {
        if (!this.selection) {
          console.warn('[Viewer] pointermove -> select with missing selection state', {
            coords,
          });
        } else {
          console.log('[Viewer] pointermove -> selection update', {
            start: this.selection.start,
            end: this.selection.end,
            next: coords,
          });
        }
        this.updateSelection(coords);
      } else {
        console.log('[Viewer] pointermove ignored - no matching branch', {
          tool: this.activeTool,
          isDragging: this.isDragging,
        });
      }
    };

    const handlePointerUp = () => {
      if (this.activeTool === 'select' && this.selection) {
        this.finishSelection();
      }
      this.isDragging = false;
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
    this.canvas.addEventListener('pointerdown', handlePointerDown);
    this.canvas.addEventListener('pointermove', handlePointerMove);
    this.canvas.addEventListener('pointerup', handlePointerUp);
    this.canvas.addEventListener('pointerleave', handlePointerUp);
    this.canvas.addEventListener('wheel', handleWheel, { passive: false });

    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (!this.currentSeries) return;
      if (event.key === 'ArrowUp') {
        this.prevImage();
      } else if (event.key === 'ArrowDown') {
        this.nextImage();
      } else if (event.key === 'c' && event.ctrlKey && this.selection) {
        this.copySelection();
      } else if (event.key === 'v' && event.ctrlKey && this.clipboard) {
        const center = [this.currentImage.columns / 2, this.currentImage.rows / 2];
        this.pasteClipboard(center);
        this.render();
      }
    });
  }
}

export { Viewer, computeWindowedPixels, ensureImageDefaults };
