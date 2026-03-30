import { loadDicomSeries } from './dicomLoader.js';
import { Viewer, computeWindowedPixels, ensureImageDefaults } from './viewer.js';
import { SaveManager } from './saveManager.js';

const inputFolder = document.getElementById('inputFolder');
const outputFolderButton = document.getElementById('outputFolderButton');
const folderStatus = document.getElementById('folderStatus');
const seriesPanel = document.getElementById('seriesPanel');
const toolbar = document.getElementById('toolbar');
const saveButton = document.getElementById('saveButton');
const helpButton = document.getElementById('helpButton');
const copyButton = document.getElementById('copyButton');
const pasteButton = document.getElementById('pasteButton');
const mergeButton = document.getElementById('mergeButton');
const brushControls = document.getElementById('brushControls');
const brushSizeInput = document.getElementById('brushSize');
const brushIntensityInput = document.getElementById('brushIntensity');
const brushSizeValue = document.getElementById('brushSizeValue');
const brushIntensityValue = document.getElementById('brushIntensityValue');
const canvas = document.getElementById('dicomCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const infoBox = document.getElementById('imageInfo');
const saveIndicator = document.getElementById('saveIndicator');

const saveManager = new SaveManager();
const viewer = new Viewer(canvas, overlayCanvas, infoBox, saveManager);

let seriesList = [];
let selectedSeriesId = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toolHotkeys = {
  w: 'window',
  p: 'pan',
  z: 'zoom',
  b: 'brush',
  s: 'select',
  k: 'eyedropper',
};

const isTextInput = (element) => {
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    element.isContentEditable ||
    element.getAttribute('role') === 'textbox'
  );
};

function updateBrushDisplay() {
  brushSizeValue.textContent = brushSizeInput.value;
  brushIntensityValue.textContent = brushIntensityInput.value;
}

function syncBrushInputs(size, intensity) {
  if (size != null) {
    brushSizeInput.value = String(size);
  }
  if (intensity != null) {
    brushIntensityInput.value = String(intensity);
  }
  updateBrushDisplay();
}

function updateBrushRange(image) {
  if (!image) return;
  const min = image.minStoredValue ?? 0;
  const max = image.maxStoredValue ?? 65535;
  brushIntensityInput.min = min;
  brushIntensityInput.max = max;
  const current = clamp(Number(brushIntensityInput.value), min, max);
  syncBrushInputs(Number(brushSizeInput.value), current);
  viewer.setBrushSettings(Number(brushSizeInput.value), current);
}

function setStatus(message) {
  folderStatus.textContent = message;
}

function toggleSaveIndicator(hasDirty) {
  if (hasDirty) {
    saveIndicator.classList.add('visible');
  } else {
    saveIndicator.classList.remove('visible');
  }
}

saveManager.onDirtyChange(toggleSaveIndicator);

toggleSaveIndicator(false);

async function handleSave() {
  try {
    const saved = await saveManager.saveAll();
    if (saved.length) {
      setStatus(`Saved ${saved.length} file(s)`);
    } else {
      setStatus('No changes to save');
    }
  } catch (err) {
    setStatus(err.message);
  }
}

function renderSeriesPanel() {
  seriesPanel.innerHTML = '';
  const template = document.getElementById('seriesCardTemplate');

  seriesList.forEach((series) => {
    if (!series.instances.length) return;
    const node = template.content.firstElementChild.cloneNode(true);
    const canvasEl = node.querySelector('canvas');
    const numberEl = node.querySelector('.series-number');
    const descriptionEl = node.querySelector('.series-description');

    numberEl.textContent = `#${series.seriesNumber}`;
    descriptionEl.textContent = series.seriesDescription || 'Series';

    const image = series.instances[0];
    const ctx = canvasEl.getContext('2d');
    canvasEl.width = 80;
    canvasEl.height = 80;
    const scale = Math.min(80 / image.columns, 80 / image.rows);
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = image.columns;
    previewCanvas.height = image.rows;
    const previewCtx = previewCanvas.getContext('2d');

    ensureImageDefaults(image);

    const imageData = previewCtx.createImageData(image.columns, image.rows);
    imageData.data.set(
      computeWindowedPixels(image, image.defaultWindowCenter, image.defaultWindowWidth),
    );
    previewCtx.putImageData(imageData, 0, 0);
    ctx.save();
    ctx.translate(40, 40);
    ctx.scale(scale, scale);
    ctx.drawImage(previewCanvas, -image.columns / 2, -image.rows / 2);
    ctx.restore();

    if (series.id === selectedSeriesId) {
      node.classList.add('active');
    }

    node.addEventListener('click', () => {
      selectedSeriesId = series.id;
      viewer.setSeries(series);
      updateBrushRange(series.instances[0]);
      renderSeriesPanel();
    });

    seriesPanel.appendChild(node);
  });
}

inputFolder.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  setStatus('Loading series…');
  seriesList = await loadDicomSeries(files);
  if (!seriesList.length) {
    setStatus('No supported DICOM or NPZ files found');
    seriesPanel.innerHTML = '';
    return;
  }
  setStatus(`${seriesList.length} series loaded`);
  selectedSeriesId = seriesList[0].id;
  viewer.setSeries(seriesList[0]);
  updateBrushRange(seriesList[0].instances[0]);
  renderSeriesPanel();
});

outputFolderButton.addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker();
    saveManager.setOutputDirectory(dirHandle);
    setStatus('Output folder selected');
  } catch (err) {
    console.warn('Directory selection cancelled', err);
  }
});

function setActiveTool(button) {
  const tool = button?.dataset.tool;
  if (!tool) return;
  toolbar.querySelectorAll('[data-tool]').forEach((btn) => btn.classList.remove('active'));
  button.classList.add('active');
  viewer.setTool(tool);
  if (tool === 'brush') {
    brushControls.style.display = 'grid';
  } else {
    brushControls.style.display = 'none';
  }
}

toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('.tool-button');
  if (!button) return;
  if (button === saveButton) {
    handleSave();
    return;
  }
  if (button === helpButton) {
    window.open('help.html', '_blank', 'noopener');
    return;
  }
  if (button === copyButton) {
    const copied = viewer.copySelection();
    setStatus(copied ? 'Selection copied to clipboard' : 'Select a region before copying');
    return;
  }
  if (button === pasteButton) {
    const pasted = viewer.beginPasteFromClipboard();
    setStatus(
      pasted
        ? 'Paste ready — click to position, scroll to adjust slices, press Merge or M to apply'
        : 'Copy a region before pasting',
    );
    return;
  }
  if (button === mergeButton) {
    const merged = viewer.commitActivePaste();
    setStatus(merged ? 'Pasted volume merged into images' : 'No active paste to merge');
    return;
  }
  if (!button.dataset.tool) return;
  setActiveTool(button);
});

brushSizeInput.addEventListener('input', () => {
  viewer.setBrushSettings(Number(brushSizeInput.value), Number(brushIntensityInput.value));
  updateBrushDisplay();
});

brushIntensityInput.addEventListener('input', () => {
  viewer.setBrushSettings(Number(brushSizeInput.value), Number(brushIntensityInput.value));
  updateBrushDisplay();
});

window.addEventListener('keydown', async (event) => {
  if (isTextInput(event.target)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === 's' && event.ctrlKey) {
    event.preventDefault();
    await handleSave();
    return;
  }

  if (!viewer.currentSeries) {
    return;
  }

  if (key === 'c' && event.ctrlKey) {
    event.preventDefault();
    const copied = viewer.copySelection();
    setStatus(copied ? 'Selection copied to clipboard' : 'Select a region before copying');
    return;
  }

  if (key === 'v' && event.ctrlKey) {
    event.preventDefault();
    const pasted = viewer.beginPasteFromClipboard();
    setStatus(
      pasted
        ? 'Paste ready — click to position, scroll to adjust slices, press Merge or M to apply'
        : 'Copy a region before pasting',
    );
    return;
  }

  if (key === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const merged = viewer.commitActivePaste();
    setStatus(merged ? 'Pasted volume merged into images' : 'No active paste to merge');
    return;
  }

  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    const tool = toolHotkeys[key];
    if (tool) {
      const toolButton = toolbar.querySelector(`[data-tool="${tool}"]`);
      if (toolButton) {
        event.preventDefault();
        setActiveTool(toolButton);
      }
    }
  }
});

setActiveTool(toolbar.querySelector('[data-tool="window"]'));
viewer.setBrushSettings(Number(brushSizeInput.value), Number(brushIntensityInput.value));
viewer.onImageChange((image) => updateBrushRange(image));
viewer.onBrushSettingsChange((size, intensity) => {
  syncBrushInputs(size, intensity);
});
updateBrushDisplay();
