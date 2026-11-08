import { z } from "zod";
import { BaseRepo } from "../storage/base-repo.mjs";
const AuditSchema=z.object({id:z.string().min(1).max(180),action:z.string().min(1).max(120),actorId:z.string().min(1).max(180),entityType:z.string().min(1).max(80),entityId:z.string().min(1).max(180),details:z.record(z.string(),z.unknown()).default({}),createdAt:z.string().datetime().optional()}).strict();
export class AuditRepo{
 #repo;
 constructor(options={}){this.#repo=new BaseRepo({...options,entityType:"audit",schema:options.schema||AuditSchema});}
 append(entry){return this.#repo.create({...entry,createdAt:entry.createdAt||new Date().toISOString()});}
 list(options){return this.#repo.list(options);}
}
