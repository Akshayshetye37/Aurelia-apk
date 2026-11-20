# Gate 3 physical-device matrix template

Copy this file to the evidence location for a frozen candidate and complete it on a real staging device. A template is not qualification evidence.

```json
{
  "candidateSha": "REPLACE_WITH_EXACT_40_CHARACTER_SHA",
  "status": "NOT QUALIFIED",
  "device": {
    "redactedLabel": "REPLACE",
    "model": "REPLACE",
    "androidApi": 0,
    "apkSha256": "REPLACE"
  },
  "cases": {
    "G3-01": "NOT RUN",
    "G3-02": "NOT RUN",
    "G3-03": "NOT RUN",
    "G3-04": "NOT RUN",
    "G3-05": "NOT RUN",
    "G3-06": "NOT RUN",
    "G3-07": "NOT RUN",
    "G3-08": "NOT RUN",
    "G3-09": "NOT RUN",
    "G3-10": "NOT RUN"
  },
  "signoff": {
    "reviewer": "",
    "signedAt": "",
    "commit": ""
  }
}
```

Do not record OTP values, raw phone numbers, credentials, serial numbers or secrets. The matrix must be committed with the exact candidate SHA and reviewed; merely changing `status` to QUALIFIED is not sufficient evidence by itself.
