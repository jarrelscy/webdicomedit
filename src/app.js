import { loadDicomSeries } from './dicomLoader.js';
import { Viewer, computeWindowedPixels, ensureImageDefaults } from './viewer.js';
import { SaveManager } from './saveManager.js';

const inputFolder = document.getElementById('inputFolder');
const outputFolderButton = document.getElementById('outputFolderButton');
const folderStatus = document.getElementById('folderStatus');
const seriesPanel = document.getElementById('seriesPanel');
const toolbar = document.getElementById('toolbar');
const saveButton = document.getElementById('saveButton');
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

function updateBrushDisplay() {
  brushSizeValue.textContent = brushSizeInput.value;
  brushIntensityValue.textContent = brushIntensityInput.value;
}

function updateBrushRange(image) {
  if (!image) return;
  const min = image.minStoredValue ?? 0;
  const max = image.maxStoredValue ?? 65535;
  brushIntensityInput.min = min;
  brushIntensityInput.max = max;
  const current = clamp(Number(brushIntensityInput.value), min, max);
  brushIntensityInput.value = current;
  viewer.setBrushSettings(Number(brushSizeInput.value), current);
  updateBrushDisplay();
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
    setStatus('No DICOM files found');
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
  toolbar.querySelectorAll('.tool-button').forEach((btn) => btn.classList.remove('active'));
  button.classList.add('active');
  const tool = button.dataset.tool;
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
  if (event.key === 's' && event.ctrlKey) {
    event.preventDefault();
    await handleSave();
  } else if (event.key === 'v' && event.ctrlKey && viewer.clipboard) {
    event.preventDefault();
    if (!viewer.currentImage) return;
    const rect = canvas.getBoundingClientRect();
    const coords = [
      (event.clientX - rect.left - viewer.offset.x) /
        (viewer.scale * (canvas.width / viewer.currentImage.columns)),
      (event.clientY - rect.top - viewer.offset.y) /
        (viewer.scale * (canvas.height / viewer.currentImage.rows)),
    ];
    viewer.pasteClipboard(coords);
    viewer.render();
  } else if (event.key === 'c' && event.ctrlKey && viewer.selection) {
    event.preventDefault();
    viewer.copySelection();
  }
});

setActiveTool(toolbar.querySelector('[data-tool="window"]'));
viewer.setBrushSettings(Number(brushSizeInput.value), Number(brushIntensityInput.value));
viewer.onImageChange((image) => updateBrushRange(image));
updateBrushDisplay();
