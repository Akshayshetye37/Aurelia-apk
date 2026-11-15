import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaperProfile, layoutReceipt } from '../src/printing/receipt-layout.mjs';
import { createReceiptModel } from '../src/printing/receipt-model.mjs';
import { encodeEscPos } from '../src/printing/escpos.mjs';
const receipt=createReceiptModel({kind:'guest-invoice',billNo:'INV-QR-1',hotelName:'Aurelia PMS',items:[{name:'Room charge',qtyMilli:1000,unitMinor:12500}],totals:[{label:'Grand total',minor:12500}],qrData:'https://example.com/invoice/INV-QR-1'});
test('paper profiles adapt to standard widths and device-reported dot widths',()=>{assert.equal(resolvePaperProfile({},'58mm').columns,32);assert.equal(resolvePaperProfile({},'80mm').columns,48);assert.equal(resolvePaperProfile({printableWidthDots:640,characterCellDots:12}).columns,53);assert.equal(resolvePaperProfile({paperWidthMm:112}).columns,69);});
test('receipt lines never exceed the detected printer columns',()=>{for(const dots of [384,576,832]){const width=Math.floor(dots/12);assert.ok(layoutReceipt(receipt,'58mm',{printableWidthDots:dots,characterCellDots:12}).every(line=>[...line].length<=width));}});
test('QR payload is validated and ESC/POS QR store/print commands are emitted',()=>{assert.throws(()=>createReceiptModel({kind:'guest-invoice',billNo:'X',hotelName:'H',items:[],qrData:'javascript:alert(1)'}),/QR data/);const bytes=[...encodeEscPos(['INVOICE'],{qrData:receipt.qrData})];assert.ok(bytes.some((v,i)=>v===0x1d&&bytes[i+1]===0x28&&bytes[i+2]===0x6b));assert.ok(bytes.includes(0x51));});
