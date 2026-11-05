# Private uploaded photos must not block manuscript saves

User-selected manuscript: 岱, 11 chapters, first chapter 她 (cloud previously 它), second 冉. Phone screenshot shows local-only edits and a retained draft. Do not replace these with cloud history or clear device storage.

Reproduction: photoAccess.register returns success with moderation review while mediaCheckAsync runs. articleSave previously rejected the entire chapter until photo moderation passed. Added service-level regression reproduces 图片未通过检查, then verifies title, text and photo reference survive in a new immutable revision.

Fix: private uploaded-photo save validates ownership, family, exact photo ID, registered file path, deletion and source restrictions independently of asynchronous moderation. AI image gates unchanged. Shared media, material copying and exports still require pass; no sharing permissions expanded.

Validation: npm run check passed (1840 tests and typecheck). Local regression covers pending/rejected/passed private photos and foreign/missing/deleted/source-bound/path-invalid denial. No user data edited. Phone-local draft recovery is NOT yet verified and requires the original phone to reopen after cloud deployment. No client upload or QR needed for this server-only change.
