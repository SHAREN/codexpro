# Repair marker instruction drift without replacing customized servers

Home PC/Home Server and current `main` include both
`codexpro_response_binding_marker` and `codexpro_response_binding_instruction`
in structuredContent. Two older VPS/HERMES runtime wrappers omitted the latter
while retaining the footer instruction. A token alone in structuredContent does
not tell a consumer to append it to the final answer.

`scripts/repair-binding-envelope.mjs` adds only the missing structured instruction
inside the recognized tagToolResult function. It requires an exact reviewed file
SHA256, defaults to check-only, keeps an exclusive backup before apply, and refuses
unrecognized functions. It does not replace server features, change marker
derivation, confirmation provenance, existing primary duplication, tool results,
or restart any process. Already-correct installations are no-ops.

After building, run `node scripts/binding-envelope-smoke.mjs` and
`node scripts/binding-marker-smoke.mjs`. Before runtime apply, check the service's
actual module path, corresponding source file, file hashes, active calls and
deployment ownership. Back up and repair both source and compiled file if present.
Run the installed Node syntax check and inspect the exact diff. Restart only the
affected managed MCP service in an idle window, then verify the new PID, loaded
code, health, normal request behavior and existing source confirmation readers.
Home PC/Home Server wrappers that already carry the instruction need no restart.

Example (placeholder hash must be replaced after inspecting the target):

```
node repair-binding-envelope.mjs /reviewed/path/dist/server.js SHA256 --check
node repair-binding-envelope.mjs /reviewed/path/dist/server.js SHA256 --apply
```

Validate subsequent genuine responses: structured token + identical instruction
and footer → exact L1 OR L2 → automatic binding → origin receipt → Threads/journal.
Preserve an existing three-node exact-anchor/trace-peer case. A passing unit test,
health response or server-side emission alone does not demonstrate ChatGPT receipt
or prove that an older missing L1/L2 was caused by this field.
