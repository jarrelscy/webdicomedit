const LITTLE_ENDIAN = true;

const TAGS = {
  SERIES_DESCRIPTION: 0x0008103e,
  SERIES_NUMBER: 0x00200011,
  SERIES_INSTANCE_UID: 0x0020000e,
  INSTANCE_NUMBER: 0x00200013,
  ROWS: 0x00280010,
  COLUMNS: 0x00280011,
  BITS_ALLOCATED: 0x00280100,
  BITS_STORED: 0x00280101,
  HIGH_BIT: 0x00280102,
  PIXEL_REPRESENTATION: 0x00280103,
  WINDOW_CENTER: 0x00281050,
  WINDOW_WIDTH: 0x00281051,
  PHOTOMETRIC_INTERPRETATION: 0x00280004,
  SAMPLES_PER_PIXEL: 0x00280002,
  PIXEL_SPACING: 0x00280030,
  PIXEL_DATA: 0x7fe00010,
};

const VR_SPECIAL = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

function readString(view, offset, length) {
  const bytes = new Uint8Array(view.buffer, offset, length);
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    text += String.fromCharCode(bytes[i]);
  }
  return text.trim();
}

function readNumberArray(value) {
  if (value == null || value === '') return [];
  return value
    .split(/\\/)
    .map((part) => part.trim())
    .filter((part) => part.length)
    .map((part) => Number(part));
}

function parseDicom(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 132) {
    throw new Error('File too small to be a valid DICOM');
  }
  const magic = readString(view, 128, 4);
  if (magic !== 'DICM') {
    throw new Error('Missing DICM marker');
  }

  let offset = 132;
  const length = view.byteLength;

  const elements = {};
  let pixelDataInfo = null;

  let explicit = true;

  while (offset + 8 <= length) {
    const group = view.getUint16(offset, LITTLE_ENDIAN);
    const element = view.getUint16(offset + 2, LITTLE_ENDIAN);
    const tag = (group << 16) | element;
    offset += 4;

    let vr = '';
    let valueLength = 0;

    if (explicit) {
      vr = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1));
      offset += 2;
      if (VR_SPECIAL.has(vr)) {
        offset += 2; // reserved
        valueLength = view.getUint32(offset, LITTLE_ENDIAN);
        offset += 4;
      } else {
        valueLength = view.getUint16(offset, LITTLE_ENDIAN);
        offset += 2;
      }
    } else {
      valueLength = view.getUint32(offset, LITTLE_ENDIAN);
      offset += 4;
    }

    if (valueLength === 0xffffffff) {
      if (vr === 'SQ' || tag === 0xfffee000) {
        // Skip sequence by searching for sequence delimitation
        let seqEnd = offset;
        while (seqEnd + 8 <= length) {
          const sqTag = view.getUint32(seqEnd, LITTLE_ENDIAN);
          const sqLength = view.getUint32(seqEnd + 4, LITTLE_ENDIAN);
          seqEnd += 8;
          if (sqTag === 0xfffee0dd) {
            offset = seqEnd;
            break;
          }
          seqEnd += sqLength;
        }
        continue;
      }
    }

    if (offset + valueLength > length) {
      break;
    }

    if (tag === TAGS.PIXEL_DATA) {
      pixelDataInfo = { offset, length: valueLength };
      break;
    }

    if (valueLength > 0) {
      if (vr === 'US' && valueLength === 2) {
        elements[tag] = view.getUint16(offset, LITTLE_ENDIAN);
      } else if ((vr === 'US' || vr === 'SS') && valueLength === 4) {
        elements[tag] = view.getUint32(offset, LITTLE_ENDIAN);
      } else if (vr === 'UL' && valueLength === 4) {
        elements[tag] = view.getUint32(offset, LITTLE_ENDIAN);
      } else {
        elements[tag] = readString(view, offset, valueLength);
      }
    } else {
      elements[tag] = '';
    }

    offset += valueLength;
  }

  if (!pixelDataInfo) {
    throw new Error('Pixel data not found');
  }

  const rows = elements[TAGS.ROWS];
  const columns = elements[TAGS.COLUMNS];
  const bitsAllocated = elements[TAGS.BITS_ALLOCATED] || 16;
  const bitsStored = elements[TAGS.BITS_STORED] || bitsAllocated;
  const highBit = elements[TAGS.HIGH_BIT] ?? bitsStored - 1;
  const samplesPerPixel = elements[TAGS.SAMPLES_PER_PIXEL] || 1;
  const pixelRepresentation = elements[TAGS.PIXEL_REPRESENTATION] || 0;

  if (!rows || !columns) {
    throw new Error('Missing image dimensions');
  }

  const frameSize = rows * columns * samplesPerPixel;
  let pixelArray;

  if (bitsAllocated === 8) {
    if (pixelRepresentation === 0) {
      pixelArray = new Uint8Array(arrayBuffer, pixelDataInfo.offset, frameSize).slice();
    } else {
      const source = new Int8Array(arrayBuffer, pixelDataInfo.offset, frameSize);
      pixelArray = new Int8Array(frameSize);
      pixelArray.set(source);
    }
  } else {
    const raw = new DataView(arrayBuffer, pixelDataInfo.offset, pixelDataInfo.length);
    const isSigned = pixelRepresentation === 1;
    pixelArray = isSigned ? new Int16Array(frameSize) : new Uint16Array(frameSize);
    let idx = 0;
    for (let i = 0; i < frameSize; i++) {
      let value = raw.getUint16(idx, LITTLE_ENDIAN);
      idx += 2;
      if (bitsStored < 16) {
        const mask = (1 << bitsStored) - 1;
        value = value & mask;
      }
      if (isSigned) {
        const signBit = 1 << highBit;
        if (value & signBit) {
          value = value - (1 << (highBit + 1));
        }
        pixelArray[i] = value;
      } else {
        pixelArray[i] = value;
      }
    }
  }

  const maxStoredValue =
    pixelRepresentation === 0 ? (1 << bitsStored) - 1 : (1 << highBit) - 1;
  const minStoredValue = pixelRepresentation === 0 ? 0 : -(1 << highBit);

  const windowCenterRaw = elements[TAGS.WINDOW_CENTER];
  const windowWidthRaw = elements[TAGS.WINDOW_WIDTH];
  const windowCenter = readNumberArray(windowCenterRaw)[0] ?? null;
  const windowWidth = readNumberArray(windowWidthRaw)[0] ?? null;
  const pixelSpacing = readNumberArray(elements[TAGS.PIXEL_SPACING]);

  return {
    elements,
    rows,
    columns,
    bitsAllocated,
    bitsStored,
    highBit,
    samplesPerPixel,
    pixelRepresentation,
    pixelArray,
    pixelDataInfo,
    windowCenter,
    windowWidth,
    pixelSpacing,
    seriesDescription: elements[TAGS.SERIES_DESCRIPTION] || 'Series',
    seriesNumber: elements[TAGS.SERIES_NUMBER] ?? null,
    seriesInstanceUID: elements[TAGS.SERIES_INSTANCE_UID] || null,
    instanceNumber: elements[TAGS.INSTANCE_NUMBER] ?? 0,
    photometricInterpretation: elements[TAGS.PHOTOMETRIC_INTERPRETATION] || 'MONOCHROME2',
    minStoredValue,
    maxStoredValue,
  };
}

export { parseDicom };
