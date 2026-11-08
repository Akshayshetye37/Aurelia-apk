export class StorageAdapter {
  constructor(){
    this.meta=Object.freeze({get:key=>this.getMeta(key),put:(key,value)=>this.putMeta(key,value),list:()=>this.list("meta")});
    this.backup=Object.freeze({get:id=>this.getBackup(id),put:(id,value)=>this.putBackup(id,value),list:()=>this.list("legacy_backup")});
  }
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
export function assertStorageAdapter(adapter){for(const method of ["transaction","get","put","list","getMeta","putMeta","getBackup","putBackup","integrityCheck","authority"])if(typeof adapter?.[method]!=="function")throw new TypeError("StorageAdapter is missing "+method);for(const area of ["meta","backup"])for(const method of ["get","put","list"])if(typeof adapter?.[area]?.[method]!=="function")throw new TypeError("StorageAdapter is missing "+area+"."+method);return adapter;}
