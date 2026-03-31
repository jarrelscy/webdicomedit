const textDecoder = new TextDecoder('utf-8');

function readUint64LE(view, offset) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 0x100000000 + low;
}

async function inflateRaw(data) {
  const stream = new Response(data).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).arrayBuffer();
}

async function inflateZlib(data) {
  const stream = new Response(data).body.pipeThrough(new DecompressionStream('deflate'));
  return await new Response(stream).arrayBuffer();
}

async function unzipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid NPZ file: missing central directory');
  }

  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const entries = new Map();

  let cdOffset = centralDirectoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    const sig = view.getUint32(cdOffset, true);
    if (sig !== 0x02014b50) {
      throw new Error('Invalid NPZ file: bad central directory header');
    }

    const compressionMethod = view.getUint16(cdOffset + 10, true);
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const fileNameLength = view.getUint16(cdOffset + 28, true);
    const extraLength = view.getUint16(cdOffset + 30, true);
    const commentLength = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const nameBytes = bytes.slice(cdOffset + 46, cdOffset + 46 + fileNameLength);
    const name = textDecoder.decode(nameBytes);

    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error('Invalid NPZ file: bad local header');
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);

    let content;
    if (compressionMethod === 0) {
      content = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      );
    } else if (compressionMethod === 8) {
      content = await inflateRaw(compressed);
    } else {
      throw new Error(`Unsupported NPZ compression method: ${compressionMethod}`);
    }

    entries.set(name, content);
    cdOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function parseNpy(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.slice(1, 6)) !== 'NUMPY') {
    throw new Error('Invalid NPY payload');
  }

  const major = bytes[6];
  const minor = bytes[7];
  let headerLength;
  let offset;
  if (major === 1) {
    headerLength = view.getUint16(8, true);
    offset = 10;
  } else if (major === 2 || major === 3) {
    headerLength = view.getUint32(8, true);
    offset = 12;
  } else {
    throw new Error(`Unsupported NPY version: ${major}.${minor}`);
  }

  const header = textDecoder.decode(bytes.slice(offset, offset + headerLength));
  const dataOffset = offset + headerLength;

  const descrMatch = header.match(/'descr':\s*'([^']+)'/);
  const fortranMatch = header.match(/'fortran_order':\s*(True|False)/);
  const shapeMatch = header.match(/'shape':\s*\(([^\)]*)\)/);

  if (!descrMatch || !fortranMatch || !shapeMatch) {
    throw new Error('Could not parse NPY header');
  }

  const descr = descrMatch[1];
  const fortranOrder = fortranMatch[1] === 'True';
  const shapeText = shapeMatch[1].trim();
  const shape = shapeText
    ? shapeText
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length)
        .map((part) => Number(part))
    : [];

  if (fortranOrder) {
    throw new Error('Fortran-order arrays are not supported');
  }

  const count = shape.length ? shape.reduce((acc, dim) => acc * dim, 1) : 1;
  let data;

  if (descr === '<f8') {
    data = new Float64Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '<f4') {
    data = new Float32Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '<i8') {
    const out = new Float64Array(count);
    const dv = new DataView(arrayBuffer, dataOffset);
    for (let i = 0; i < count; i++) {
      out[i] = readUint64LE(dv, i * 8);
    }
    data = out;
  } else if (descr === '<i4') {
    data = new Int32Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '<u4') {
    data = new Uint32Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '<i2') {
    data = new Int16Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '<u2') {
    data = new Uint16Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '<i1') {
    data = new Int8Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr === '|u1') {
    data = new Uint8Array(arrayBuffer, dataOffset, count).slice();
  } else if (descr.startsWith('|S')) {
    const size = Number(descr.slice(2));
    const out = [];
    const raw = new Uint8Array(arrayBuffer, dataOffset, count * size);
    for (let i = 0; i < count; i++) {
      const chunk = raw.slice(i * size, (i + 1) * size);
      let end = chunk.length;
      while (end > 0 && chunk[end - 1] === 0) end--;
      out.push(chunk.slice(0, end));
    }
    data = out;
  } else {
    throw new Error(`Unsupported NPY dtype: ${descr}`);
  }

  return {
    descr,
    shape,
    data,
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterPngScanlines(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(height * stride);
  let inOffset = 0;
  let outOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[inOffset++];
    const rowStart = outOffset;

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[inOffset++];
      const left = x >= bytesPerPixel ? out[outOffset - bytesPerPixel] : 0;
      const up = y > 0 ? out[rowStart - stride + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[rowStart - stride + x - bytesPerPixel] : 0;

      let value;
      if (filterType === 0) {
        value = rawByte;
      } else if (filterType === 1) {
        value = (rawByte + left) & 0xff;
      } else if (filterType === 2) {
        value = (rawByte + up) & 0xff;
      } else if (filterType === 3) {
        value = (rawByte + Math.floor((left + up) / 2)) & 0xff;
      } else if (filterType === 4) {
        value = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter type: ${filterType}`);
      }

      out[outOffset++] = value;
    }
  }

  return out;
}

async function decodePngToPixels(pngBytes) {
  const bytes = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) {
      throw new Error('Invalid PNG signature in png_list entry');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    offset += 4;
    const type = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    offset += 4;

    const chunkData = bytes.slice(offset, offset + length);
    offset += length;
    offset += 4; // CRC

    if (type === 'IHDR') {
      const hdr = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
      width = hdr.getUint32(0, false);
      height = hdr.getUint32(4, false);
      bitDepth = hdr.getUint8(8);
      colorType = hdr.getUint8(9);
      interlace = hdr.getUint8(12);
    } else if (type === 'IDAT') {
      idatParts.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) {
    throw new Error('PNG missing IHDR dimensions');
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNG is not supported');
  }
  if (colorType !== 0) {
    throw new Error(`Unsupported PNG color type ${colorType}; expected grayscale PNG`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth}; expected 8 or 16`);
  }

  const totalIdatSize = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(totalIdatSize);
  let writeOffset = 0;
  for (const part of idatParts) {
    compressed.set(part, writeOffset);
    writeOffset += part.length;
  }

  const inflatedBuffer = await inflateZlib(compressed);
  const inflated = new Uint8Array(inflatedBuffer);
  const bytesPerPixel = bitDepth / 8;
  const unfiltered = unfilterPngScanlines(inflated, width, height, bytesPerPixel);

  const pixels = new Int32Array(width * height);
  if (bitDepth === 8) {
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = unfiltered[i];
    }
  } else {
    let read = 0;
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = (unfiltered[read] << 8) | unfiltered[read + 1];
      read += 2;
    }
  }

  return {
    rows: height,
    columns: width,
    pixelArray: pixels,
  };
}

function scalarValue(parsed) {
  return Array.isArray(parsed.data) ? parsed.data[0] : parsed.data[0];
}

async function loadNpzFile(file) {
  const buffer = await file.arrayBuffer();
  const entries = await unzipEntries(buffer);

  const arrays = new Map();
  for (const [name, payload] of entries) {
    if (!name.endsWith('.npy')) continue;
    arrays.set(name.slice(0, -4), parseNpy(payload));
  }

  const pngList = arrays.get('png_list');
  if (!pngList) {
    throw new Error('NPZ missing png_list array');
  }
  if (!Array.isArray(pngList.data)) {
    throw new Error('png_list dtype is unsupported; expected byte strings');
  }

  const offsetArray = arrays.get('png_offset');
  const pngOffset = offsetArray ? Number(scalarValue(offsetArray)) : 0;
  const spacingArray = arrays.get('registered_spacing') || arrays.get('original_spacing');
  const pixelSpacing = spacingArray ? Array.from(spacingArray.data) : [];

  const instances = [];
  for (let i = 0; i < pngList.data.length; i++) {
    const pngBytes = pngList.data[i];
    const decoded = await decodePngToPixels(pngBytes);
    const adjusted = new Int32Array(decoded.pixelArray.length);
    let min = Infinity;
    let max = -Infinity;
    for (let p = 0; p < decoded.pixelArray.length; p++) {
      const hu = decoded.pixelArray[p] - pngOffset;
      adjusted[p] = hu;
      if (hu < min) min = hu;
      if (hu > max) max = hu;
    }

    instances.push({
      file: { name: `${file.name}#${String(i + 1).padStart(4, '0')}.png` },
      sourceFile: file,
      sourceFormat: 'npz',
      rows: decoded.rows,
      columns: decoded.columns,
      bitsAllocated: 32,
      bitsStored: 32,
      highBit: 31,
      samplesPerPixel: 1,
      pixelRepresentation: 1,
      pixelArray: adjusted,
      pixelDataInfo: null,
      buffer: null,
      windowCenter: null,
      windowWidth: null,
      pixelSpacing,
      rescaleIntercept: 0,
      rescaleSlope: 1,
      seriesDescription: file.name,
      seriesNumber: 1,
      seriesInstanceUID: `${file.name}-npz`,
      instanceNumber: i + 1,
      photometricInterpretation: 'MONOCHROME2',
      minStoredValue: min,
      maxStoredValue: max,
      dirty: false,
    });
  }

  return {
    id: `${file.name}-npz`,
    seriesNumber: 1,
    seriesDescription: `${file.name} (NPZ)`,
    instances,
    sourceFormat: 'npz',
  };
}

export { loadNpzFile };
