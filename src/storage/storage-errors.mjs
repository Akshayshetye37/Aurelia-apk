export class StorageFullError extends Error {
  constructor(message = "Device storage is full. Export your PMS data and free space before continuing.", options = {}) {
    super(message, options);
    this.name = "StorageFullError";
    this.code = "STORAGE_FULL";
    this.action = "EXPORT_DATA";
  }
}
