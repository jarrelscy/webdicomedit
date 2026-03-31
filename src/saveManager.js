class SaveManager {
  constructor() {
    this.dirtyImages = new Set();
    this.outputDirectory = null;
    this.listeners = new Set();
  }

  setOutputDirectory(handle) {
    this.outputDirectory = handle;
  }

  onDirtyChange(callback) {
    this.listeners.add(callback);
  }

  notify() {
    for (const cb of this.listeners) {
      cb(this.dirtyImages.size > 0);
    }
  }

  markDirty(image) {
    this.dirtyImages.add(image);
    this.notify();
  }

  clearDirty(image) {
    this.dirtyImages.delete(image);
    this.notify();
  }

  clearAll() {
    this.dirtyImages.clear();
    this.notify();
  }

  get hasDirty() {
    return this.dirtyImages.size > 0;
  }

  async saveAll() {
    if (!this.outputDirectory) {
      throw new Error('Output folder not selected');
    }

    const unsupported = Array.from(this.dirtyImages).filter((image) => image.sourceFormat !== 'dicom');
    if (unsupported.length) {
      throw new Error('Saving NPZ-derived slices is not supported yet');
    }

    const results = [];
    for (const image of Array.from(this.dirtyImages)) {
      const fileHandle = await this.outputDirectory.getFileHandle(image.file.name, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      const buffer = image.buffer.slice(0);
      const { offset, length } = image.pixelDataInfo;
      const dataView = new DataView(buffer, offset, length);
      if (image.bitsAllocated === 8) {
        const bytes = new Uint8Array(buffer, offset, length);
        const minValue = image.minStoredValue ?? 0;
        const maxValue = image.maxStoredValue ?? 255;
        for (let i = 0; i < image.pixelArray.length; i++) {
          const value = Math.min(Math.max(image.pixelArray[i], minValue), maxValue);
          bytes[i] = value & 0xff;
        }
      } else {
        const minValue = image.minStoredValue ?? 0;
        const maxValue = image.maxStoredValue ?? 65535;
        let idx = 0;
        for (let i = 0; i < image.pixelArray.length; i++) {
          const value = Math.min(Math.max(image.pixelArray[i], minValue), maxValue);
          if (image.pixelRepresentation === 1) {
            dataView.setInt16(idx, value, true);
          } else {
            dataView.setUint16(idx, value, true);
          }
          idx += 2;
        }
      }
      await writable.write(buffer);
      await writable.close();
      image.dirty = false;
      this.clearDirty(image);
      results.push(image.file.name);
    }
    return results;
  }
}

export { SaveManager };
