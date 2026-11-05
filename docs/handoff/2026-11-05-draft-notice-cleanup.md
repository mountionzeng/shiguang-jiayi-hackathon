# Draft notice cleanup

Removed the standalone retained-draft notice and button from the contents header. Retained drafts remain accessible within the existing History panel, with the existing text-copy action. No draft storage or recovery data removed. Successful background recovery clears an unchanged old save notice.

Validation: typecheck and 1840 tests passed. Desktop UI: opened 岱 from home, opened More -> History, observed loaded cloud revision list. Directory has no retained-draft header card. This desktop has no retained phone draft, so the original phone button failure and retained-content display/copy could NOT be reproduced or accepted here. No user content modified. Cloud newest observed record remains 2026-11-05T14:30:15.652Z; phone-local recovery is still unconfirmed.

Client changes are committed but not uploaded or set as the experience version in this task. Cloud private-photo save fix is the separate deployed commit 2fd526a.
