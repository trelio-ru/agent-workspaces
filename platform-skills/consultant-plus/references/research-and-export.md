# Research and export procedure

## Search and select the legal source

Start from `https://cloud.consultant.ru/` and use the visible ConsultantPlus
search. Prefer an exact document number, title and provision when the request
contains them. For a conceptual question, keep the search bounded and inspect
the most relevant result before widening it.

Do not treat dynamic navigation parameters, cache identifiers or result-list
URLs as durable citations. After opening a document, preserve the stable
visible source URL when one is available and always record human-readable
requisites.

Before relying on text, verify from the document UI:

- full title and document type;
- issuing body, number and date where applicable;
- current, historical or future edition;
- effective date and any notice that the displayed edition has not taken
  effect;
- exact article, part, clause, chapter, form or commentary section used.

If the user asks what the law says “now”, use the edition effective on the
relevant date, not merely the newest text shown by the system. When legal effect
depends on a past or future date, state that date explicitly and compare
editions only as far as the task requires.

## Read without over-collecting

Use the document table of contents or in-document search to reach the exact
provision. Read enough neighboring text to preserve conditions, exceptions,
cross-references and notes, but avoid collecting unrelated chapters or search
results.

Quote only the amount needed for the user's purpose. Separate statutory text,
court holdings and ConsultantPlus commentary in the answer. Never present a
commentary annotation as the legal act itself.

## Decide whether to download

Do not download by default for a quick answer that can be verified and cited
from the live page.

Download autonomously when at least one condition applies:

- the user asked to save, attach, preserve, compare or continue working with
  the source;
- an exact source should accompany a durable Trelio workspace result;
- the task involves a long provision, table, form, historical edition or
  multiple cross-references that are unsafe to reconstruct from excerpts;
- the browser URL is session-bound and the file is the more reliable evidence;
- later document analysis needs stable local bytes.

The original provider export is evidence, not a draft. Keep it unchanged and
make any annotated, converted or summarized version as a separate file.

## Choose export scope and format

Use the document's export/save control and choose the narrowest complete scope:
exact article or selected fragment first, then chapter/section, and the whole
law only when the task genuinely needs the full document. Confirm the exported
file contains the requested scope after download.

Format priority:

1. `DOCX` for laws, articles, chapters, commentary and most tables. It is the
   default working source because agents can reliably inspect its structure,
   links and requisites.
2. `PDF` for official forms, page-sensitive annexes, printable layouts or when
   visual placement matters to meaning.
3. `UNICODE` text when DOCX/PDF are unavailable or a structured export fails.
   Preserve UTF-8 or UTF-16 accurately and never silently substitute a lossy
   legacy encoding.

Do not prefer RTF, EPUB, FB2, HTML or XML unless a downstream task explicitly
requires that format. Do not mass-download result lists, all editions or a
large corpus.

## Preserve provenance

Use a readable filename that identifies the source and scope without inventing
an official name. Alongside the file or in the final result, record:

- exact document title and number;
- article/chapter/form or selected fragment;
- displayed edition and effective date when relevant;
- `cloud.consultant.ru` as the provider and the stable visible URL when
  available;
- download date in `YYYY-MM-DD`;
- whether the file is an original ConsultantPlus export or a derivative.

Verify the completed download exists, opens, and contains the intended
fragment. A browser download event alone is insufficient. Move or copy the
source into the task's authorized material directory when durable storage is
needed; do not use the Downloads folder as permanent integration state.

## Independent-source fallback

For Russian legislation, prefer the official publication portal and the
official issuing-body page. For court practice, prefer the relevant court or
official judicial database. For regulator explanations, prefer the regulator's
own site. Use other configured legal research tools or broader web research
only after those sources are insufficient.

State why ConsultantPlus was not used: `no_access`, `needs_reconnect`,
`unavailable_on_surface`, `unsupported_operation`, or no enabled relevant
Trelio skill. Cite the independent source actually inspected. If proprietary
ConsultantPlus commentary was requested and cannot be retrieved, say that the
public fallback cannot reproduce it rather than fabricating an equivalent.
