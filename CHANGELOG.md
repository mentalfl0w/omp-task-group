# Changelog

## 1.3.0-beta.0

- Add an explicit opt-in background mode using OMP's native Workpool for homogeneous `all` + `collect` groups. It does not enable or modify `eval.autoBackground`.
- Deliver the native Workpool completion preview, then require an explicit Collect to validate the retained snapshot and apply the shared Result Gate. The preview is not the final result and may contain ungated output.
- Store the gated result through a write-approved, path-restricted tool in a private temporary file with SHA-256 verification. Read results in segments and confirm consumption to delete the file; unconsumed results expire under the documented retention policy.
- Preserve Workpool item failures and native failed-batch diagnostics, handle all-cancelled groups, and retain ordinary structured worker outputs without treating them as failure envelopes.
- Fail closed when the retained kernel handle or session registration is unavailable. A kernel reset or session switch before Collect can prevent recovery; do not re-dispatch already-started tasks.
- Background Workpool is Beta: it requires explicit Collect, supports only the documented eligible task shape, and does not provide a single bounded end-to-end delivery. Foreground Fanout and Pool remain available.
