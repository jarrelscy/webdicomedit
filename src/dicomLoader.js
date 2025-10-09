import { parseDicom } from './utils/dicomParser.js';

function bufferContainsDicom(bytes) {
  if (bytes.byteLength < 132) return false;
  const view = new DataView(bytes);
  let magic = '';
  for (let i = 128; i < 132; i++) {
    magic += String.fromCharCode(view.getUint8(i));
  }
  return magic === 'DICM';
}

async function isDicomFile(file) {
  const headerSlice = await file.slice(0, 132).arrayBuffer();
  return bufferContainsDicom(headerSlice);
}

async function loadDicomFromFile(file) {
  const buffer = await file.arrayBuffer();
  const parsed = parseDicom(buffer);
  return {
    file,
    buffer,
    ...parsed,
    dirty: false,
  };
}

async function loadDicomSeries(files) {
  const seriesMap = new Map();

  for (const file of files) {
    try {
      const isDicom = await isDicomFile(file);
      if (!isDicom) continue;
      const dicom = await loadDicomFromFile(file);
      const seriesKey =
        dicom.seriesInstanceUID || `${dicom.seriesNumber ?? '0'}-${dicom.seriesDescription}`;
      if (!seriesMap.has(seriesKey)) {
        seriesMap.set(seriesKey, {
          id: seriesKey,
          seriesNumber: dicom.seriesNumber ?? '—',
          seriesDescription: dicom.seriesDescription ?? 'Unnamed Series',
          instances: [],
        });
      }
      seriesMap.get(seriesKey).instances.push(dicom);
    } catch (err) {
      console.warn('Failed to load DICOM', file.name, err);
    }
  }

  for (const series of seriesMap.values()) {
    series.instances.sort((a, b) => a.instanceNumber - b.instanceNumber);
  }

  return Array.from(seriesMap.values()).sort((a, b) => {
    const numA = Number(a.seriesNumber);
    const numB = Number(b.seriesNumber);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      return a.seriesDescription.localeCompare(b.seriesDescription);
    }
    return numA - numB;
  });
}

export { loadDicomSeries };
