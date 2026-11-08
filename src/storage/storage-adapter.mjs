export class StorageAdapter {
  transaction(){throw new Error("StorageAdapter.transaction is not implemented");}
  get(){throw new Error("StorageAdapter.get is not implemented");}
  put(){throw new Error("StorageAdapter.put is not implemented");}
  list(){throw new Error("StorageAdapter.list is not implemented");}
  getMeta(){throw new Error("StorageAdapter.getMeta is not implemented");}
  putMeta(){throw new Error("StorageAdapter.putMeta is not implemented");}
  getBackup(){throw new Error("StorageAdapter.getBackup is not implemented");}
  putBackup(){throw new Error("StorageAdapter.putBackup is not implemented");}
  integrityCheck(){throw new Error("StorageAdapter.integrityCheck is not implemented");}
  authority(){throw new Error("StorageAdapter.authority is not implemented");}
}
export function assertStorageAdapter(adapter){for(const method of ["transaction","get","put","list","getMeta","putMeta","getBackup","putBackup","integrityCheck","authority"])if(typeof adapter?.[method]!=="function")throw new TypeError("StorageAdapter is missing "+method);return adapter;}
