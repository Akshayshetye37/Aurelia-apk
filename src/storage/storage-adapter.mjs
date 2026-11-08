export class StorageAdapter {
  constructor(){
    this.meta=Object.freeze({get:key=>this.getMeta(key),put:(key,value)=>this.putMeta(key,value),list:()=>this.list("meta")});
    this.backup=Object.freeze({get:id=>this.getBackup(id),put:(id,value)=>this.putBackup(id,value),list:()=>this.list("legacy_backup"),create:id=>this.createBackup(id),restore:snapshot=>this.restoreSnapshot(snapshot)});
  }
  transaction(){throw new Error("StorageAdapter.transaction is not implemented");}
  get(){throw new Error("StorageAdapter.get is not implemented");}
  put(){throw new Error("StorageAdapter.put is not implemented");}
  list(){throw new Error("StorageAdapter.list is not implemented");}
  getMeta(){throw new Error("StorageAdapter.getMeta is not implemented");}
  putMeta(){throw new Error("StorageAdapter.putMeta is not implemented");}
  getBackup(){throw new Error("StorageAdapter.getBackup is not implemented");}
  putBackup(){throw new Error("StorageAdapter.putBackup is not implemented");}
  createBackup(){throw new Error("StorageAdapter.createBackup is not implemented");}
  restoreSnapshot(){throw new Error("StorageAdapter.restoreSnapshot is not implemented");}
  integrityCheck(){throw new Error("StorageAdapter.integrityCheck is not implemented");}
  wipe(){throw new Error("StorageAdapter.wipe is not implemented");}
  authorityRecord(){throw new Error("StorageAdapter.authorityRecord is not implemented");}
  setAuthorityRecord(){throw new Error("StorageAdapter.setAuthorityRecord is not implemented");}
  authority(){throw new Error("StorageAdapter.authority is not implemented");}
}
export function assertStorageAdapter(adapter){for(const method of ["transaction","get","put","list","getMeta","putMeta","getBackup","putBackup","createBackup","restoreSnapshot","integrityCheck","authority"])if(typeof adapter?.[method]!=="function")throw new TypeError("StorageAdapter is missing "+method);for(const area of ["meta","backup"])for(const method of ["get","put","list",...(area==="backup"?["create","restore"]:[])])if(typeof adapter?.[area]?.[method]!=="function")throw new TypeError("StorageAdapter is missing "+area+"."+method);return adapter;}
