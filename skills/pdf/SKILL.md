---
name: pdf
description: Extract text and tables from PDF files for downstream processing.
---

# PDF

To work with PDFs:

1. Use `bash` to call a PDF tool (e.g. `pdftotext file.pdf -` or `python -c "import pypdf..."`).
2. If the tool is unavailable, tell the user which package to install.
3. Summarize extracted content; quote page numbers when relevant.
4. For tables, prefer converting to CSV/Markdown before further analysis.
