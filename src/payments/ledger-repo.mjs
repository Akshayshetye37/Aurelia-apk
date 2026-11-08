import { z } from "zod";
import { BaseRepo } from "../storage/base-repo.mjs";
const LedgerSchema=z.object({id:z.string().min(1).max(180),folioId:z.string().min(1).max(180),paymentId:z.string().min(1).max(180).nullable().optional(),amountPaise:z.number().int().safe(),currency:z.literal("INR"),entryType:z.enum(["CHARGE","PAYMENT","REFUND","ADJUSTMENT"]),reference:z.string().max(256).nullable().optional(),createdAt:z.string().datetime().optional()}).strict();
export class LedgerRepo{
 #repo;
 constructor(options={}){this.#repo=new BaseRepo({...options,entityType:"ledger",schema:options.schema||LedgerSchema});}
 append(entry){return this.#repo.create({...entry,createdAt:entry.createdAt||new Date().toISOString()});}
 list(options){return this.#repo.list(options);}
}
