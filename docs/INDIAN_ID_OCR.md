# Indian identity-document OCR — implementation and acceptance

## Supported document families

The existing parser recognises Aadhaar, PAN, Passport, Voter ID/EPIC, Driving Licence, Ration Card, UDID, ABHA and foreign/NRC identity labels. Current work adds Devanagari script recognition and Marathi/Hindi labels for Aadhaar, Voter ID and Driving Licence. The Devanagari ML Kit recognizer recognises both Latin and Devanagari text.

## Extraction contract

1. Capture a clear, in-focus, well-lit image. Keep the complete card inside the frame; capture front/back where the identifier or holder name may be split.
2. Run on-device OCR. Do not upload ID images or extracted text to a remote OCR service.
3. Classify document type using issuer/title/layout cues, not a single short token.
4. Extract the holder name only from an explicitly labelled holder/elector/applicant name field. Do not treat father, mother, spouse, guardian or address text as the holder.
5. Extract an ID number only when the document-specific format validates. Apply Aadhaar Verhoeff validation and passport MRZ check digits where available.
6. Return candidate fields with validation/confidence metadata. OCR suggestions are never silently treated as verified identity.
7. Require staff to compare every candidate with the image and explicitly confirm before saving. Ambiguous fields stay blank and require manual entry.
8. Do not use OCR as proof of document authenticity, citizenship, age, or entitlement. OCR can misread characters and forged documents can contain valid-looking numbers.

## Aadhaar privacy boundary

- Never persist a complete Aadhaar number in the guest profile, audit log, exports or analytics.
- The current branch masks a checksum-verified 12-digit OCR candidate as `XXXX-XXXX-NNNN`; a non-checksum-valid candidate is not auto-populated.
- Do not retain an unmasked Aadhaar image. Use a UIDAI-masked Aadhaar copy or an authorised UIDAI offline-verification flow with informed consent. A secure QR/XML verifier is a separate feature and must validate authenticity, signature, expiry and consent; OCR is not a substitute.
- Confirm applicable UIDAI rules and local lodging/FRRO record requirements with qualified counsel before enabling ID capture/storage in production.

## Accuracy qualification

"Perfect OCR" cannot be guaranteed. Accuracy must be measured on a consented, legally obtained, de-identified test corpus spanning document versions, languages, fonts, glare, blur, folds, low light, skew, old cards, front/back images and low-end Android cameras.

Release gates:
- Per-document-type exact match rate for holder name and ID number.
- False-positive rate (wrong field accepted) and false-negative rate (field left blank).
- Character error rate and field-level precision/recall, separately for Latin and Devanagari.
- Confidence calibration and manual-review rate.
- No cross-field substitution (e.g. father's name used as holder name).
- No full Aadhaar number in app state, local persistence, logs, exports or telemetry.
- Manual correction path remains available for every field.
- Physical-device tests on supported Android API levels and representative camera hardware.

A model update, parser change or image preprocessing change must rerun the full corpus. Do not advertise an accuracy percentage until measured results exist.
