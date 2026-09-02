# OCR and vision artifacts

Read this file completely before storing agent-produced OCR or vision output in
an Agent Workspace.

Perform OCR/vision only when needed. Store the result and a sibling
`extraction-manifest.json`:

```json
{
  "schemaVersion": 1,
  "source": {
    "path": "sources/contract-scan.pdf",
    "digest": "sha256:<64 lowercase hex characters>"
  },
  "artifact": {
    "path": "derived/contract-scan/extracted-text.md",
    "type": "ocr_text"
  },
  "extraction": {
    "method": "agent-vision",
    "verificationStatus": "machine_extracted"
  },
  "warnings": ["Page 7 is low quality"]
}
```

Use only `machine_extracted` or `agent_visually_checked`. Never claim
`human_verified`; Trelio records it only after an authorized person confirms
the current accepted artifact. Cite original pages/images for material dates,
sums, percentages, signatures, and identifiers.

The same flow applies to plain and encrypted companies. For an encrypted
Workspace, `finish` validates the manifest and exact committed source locally,
then prints each accepted artifact UUID and its exact `source -> artifact` pair.
Show that pair to the user. Call `verify_agent_workspace_derived_artifact` only
after the user explicitly confirms that they checked this concrete accepted
artifact against this concrete source; advance permission to run a test does
not replace the post-creation comparison.
